package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

var testLayout = Layout{
	Home:     "/home/u",
	Checkout: "/home/u/termag/projects/app",
	Run:      "/home/u/.local/state/termag-preview/r1",
}

// Pinning (SR9): every rule under $HOME is the checkout root or its
// node_modules (read-only), the run directory (the only writable rule), or a
// named cache or toolchain (read-only).
func TestAppGrantsKeepTheInvariant(t *testing.T) {
	for _, cg := range []CheckoutGrant{CheckoutNodeModules, CheckoutNone} {
		if err := CheckGrants(testLayout, AppGrants(testLayout, cg), ""); err != nil {
			t.Errorf("%s: %v", cg, err)
		}
	}
	work := filepath.Join(testLayout.Run, "work")
	if err := CheckGrants(testLayout, SyncGrants(testLayout, work, nil), work); err != nil {
		t.Errorf("sync: %v", err)
	}
	if err := CheckGrants(testLayout, CleanGrants(testLayout), ""); err != nil {
		t.Errorf("clean: %v", err)
	}
}

func TestOnlyTheRunDirectoryIsWritable(t *testing.T) {
	for _, g := range AppGrants(testLayout, CheckoutNodeModules) {
		if g.Access == ReadWrite && g.Path != testLayout.Run {
			t.Errorf("%s is writable", g.Path)
		}
	}
}

// Pinning (SR9): ~/.aws, ~/.ssh, ~/.config, the box agent's config, /tmp and
// other checkouts are not reachable: no rule is one of them or an ancestor.
func TestSecretsAreNotCovered(t *testing.T) {
	secrets := []string{
		"/home/u/.aws/credentials", "/home/u/.ssh/id_ed25519", "/home/u/.config/gh/hosts.yml",
		"/home/u/src/termag/agent/agent.config.json", "/home/u/.termag/agent.config.json",
		"/home/u/.npmrc", "/home/u/.nvm/alias/default", "/home/u/.gitconfig",
		"/tmp/tmux-1001/default", "/home/u/termag/projects/other/.env",
		"/run/user/1001/bus", "/var/run/docker.sock", "/etc/shadow", "/etc/sudoers",
		"/opt/termag-t3", "/snap",
	}
	for _, cg := range []CheckoutGrant{CheckoutNodeModules, CheckoutNone} {
		for _, g := range AppGrants(testLayout, cg) {
			for _, s := range secrets {
				if g.Access != ListDir && within(s, g.Path) {
					t.Errorf("%s: rule %s covers %s", cg, g.Path, s)
				}
			}
		}
	}
}

// The default grant doesn't reach the checkout's .git or its ignored .env:
// the prototype served .git/config through /@fs/ when the whole checkout was
// granted.
func TestDefaultGrantLeavesTheCheckoutsGitAndEnvOut(t *testing.T) {
	for _, p := range []string{"/.git/config", "/.git/hooks/pre-commit", "/.env", "/package.json"} {
		for _, g := range AppGrants(testLayout, CheckoutNodeModules) {
			// The checkout root's list-only rule shows names, not contents.
			if g.Access != ListDir && within(testLayout.Checkout+p, g.Path) {
				t.Errorf("rule %s covers %s", g.Path, p)
			}
		}
	}
}

func TestCheckGrantsRefuses(t *testing.T) {
	base := AppGrants(testLayout, CheckoutNodeModules)
	cases := map[string]Grant{
		"inside the checkout": {Path: testLayout.Checkout + "/.git/hooks", Origin: FromHome, Access: ReadExec},
		"a build output":      {Path: testLayout.Checkout + "/dist", Origin: FromHome, Access: ReadExec},
		"another home path":   {Path: "/home/u/.aws", Origin: FromHome, Access: ReadExec},
		"a writable cache":    {Path: "/home/u/.npm", Origin: FromHome, Access: ReadWrite},
		"a home system path":  {Path: "/home/u/.local/bin", Origin: FromSystem, Access: ReadExec},
		"a writable /tmp":     {Path: "/tmp", Origin: FromSystem, Access: ReadWrite},
	}
	for name, g := range cases {
		if err := CheckGrants(testLayout, append(append([]Grant{}, base...), g), ""); err == nil {
			t.Errorf("%s: %s accepted", name, g.Path)
		}
	}
}

func TestCheckLayoutRefuses(t *testing.T) {
	cases := map[string]Layout{
		"run inside checkout": {Home: "/home/u", Checkout: "/home/u/app", Run: "/home/u/app/.run"},
		"checkout inside run": {Home: "/home/u", Checkout: "/home/u/r/app", Run: "/home/u/r"},
		"checkout is home":    {Home: "/home/u", Checkout: "/home/u", Run: "/home/u/r"},
		"checkout outside":    {Home: "/home/u", Checkout: "/srv/app", Run: "/home/u/r"},
		"relative":            {Home: "/home/u", Checkout: "app", Run: "/home/u/r"},
		"unclean":             {Home: "/home/u", Checkout: "/home/u/x/../app", Run: "/home/u/r"},
	}
	for name, l := range cases {
		if err := CheckLayout(l); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if err := CheckLayout(testLayout); err != nil {
		t.Error(err)
	}
}

func TestEtcIsNamedEntriesOnly(t *testing.T) {
	for _, g := range AppGrants(testLayout, CheckoutNodeModules) {
		if g.Path == "/etc" {
			t.Error("/etc granted whole")
		}
		if strings.HasPrefix(g.Path, "/etc/") && g.Access == ReadWrite {
			t.Errorf("%s writable", g.Path)
		}
	}
}

func TestBuildEnv(t *testing.T) {
	ok := []string{"PATH=/usr/bin", "HOME=/home/u", "TMPDIR=/home/u/r/tmp", "PORT=3000"}
	env, err := BuildEnv(ok)
	if err != nil || len(env) != 4+len(FixedEnv) {
		t.Fatalf("BuildEnv(%v) = %v, %v", ok, env, err)
	}
	// pnpm's pre-run install check is off for every app, and the agent can't turn it back on.
	if !slices.Contains(env, "PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false") {
		t.Errorf("BuildEnv(%v) = %v, without PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false", ok, env)
	}
	if _, err := BuildEnv(append(append([]string{}, ok...), "PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=true")); err == nil {
		t.Error("the agent overrode PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN")
	}
	for _, bad := range []string{"GITHUB_TOKEN=x", "AWS_SECRET_ACCESS_KEY=x", "SSH_AUTH_SOCK=/x", "TMUX=/x", "DBUS_SESSION_BUS_ADDRESS=x", "TERMAG_TOKEN=x", "LD_PRELOAD=/x", "NODE_OPTIONS=--inspect"} {
		if _, err := BuildEnv(append(append([]string{}, ok...), bad)); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
	if _, err := BuildEnv([]string{"PATH=/usr/bin"}); err == nil {
		t.Error("missing HOME and TMPDIR accepted")
	}
}

func TestSeccompProgramFitsBPFJumps(t *testing.T) {
	p, err := SeccompProgram()
	if err != nil {
		t.Skip(err)
	}
	if len(p) > 4096 {
		t.Fatalf("%d instructions", len(p))
	}
	for i, ins := range p {
		if ins.Code&0x07 != bpfJMP {
			continue
		}
		if int(ins.Jt)+i+1 >= len(p) || int(ins.Jf)+i+1 >= len(p) {
			t.Errorf("instruction %d jumps past the end", i)
		}
	}
}

// runFilter evaluates a seccomp program over one system call, for the instructions SeccompProgram uses.
func runFilter(t *testing.T, p []unix.SockFilter, arch, nr uint32, args ...uint64) uint32 {
	t.Helper()
	data := make([]byte, 64)
	binary.LittleEndian.PutUint32(data[0:], nr)
	binary.LittleEndian.PutUint32(data[4:], arch)
	for i, a := range args {
		binary.LittleEndian.PutUint64(data[16+8*i:], a)
	}
	var acc uint32
	for pc := 0; pc < len(p); pc++ {
		ins := p[pc]
		switch ins.Code {
		case bpfLD | bpfW | bpfABS:
			acc = binary.LittleEndian.Uint32(data[ins.K:])
		case bpfALU | bpfAND | bpfK:
			acc &= ins.K
		case bpfJMP | bpfJEQ | bpfK, bpfJMP | bpfJGE | bpfK, bpfJMP | bpfJSET | bpfK:
			var hit bool
			switch ins.Code &^ 0x07 &^ bpfK {
			case bpfJEQ:
				hit = acc == ins.K
			case bpfJGE:
				hit = acc >= ins.K
			case bpfJSET:
				hit = acc&ins.K != 0
			}
			if hit {
				pc += int(ins.Jt)
			} else {
				pc += int(ins.Jf)
			}
		case bpfRET | bpfK:
			return ins.K
		default:
			t.Fatalf("instruction %d: code %#x", pc, ins.Code)
		}
	}
	t.Fatal("ran off the end")
	return 0
}

// Pinning (Cursor Security Agent, #1519), on any Linux machine, Landlock or not (no CI job runs these tests): the socket rule's decision for each family,
// type (with and without SOCK_NONBLOCK and SOCK_CLOEXEC) and protocol. confine_test.go checks the same on the
// real kernel.
func TestSocketRule(t *testing.T) {
	p, err := SeccompProgram()
	if err != nil {
		t.Skip(err)
	}
	arch, _ := nativeArch()
	allow, eacces, noFamily := uint32(seccompRetAllow), unix.SECCOMP_RET_ERRNO|uint32(unix.EACCES), unix.SECCOMP_RET_ERRNO|uint32(unix.EAFNOSUPPORT)
	const flags = unix.SOCK_NONBLOCK | unix.SOCK_CLOEXEC
	for _, c := range []struct {
		fam, typ, proto int
		want            uint32
	}{
		{unix.AF_INET, unix.SOCK_STREAM, 0, allow},
		{unix.AF_INET, unix.SOCK_STREAM | flags, unix.IPPROTO_TCP, allow},
		{unix.AF_INET6, unix.SOCK_STREAM | unix.SOCK_NONBLOCK, 0, allow},
		{unix.AF_INET, unix.SOCK_DGRAM, 0, allow},
		{unix.AF_INET6, unix.SOCK_DGRAM | flags, unix.IPPROTO_UDP, allow},
		{unix.AF_NETLINK, unix.SOCK_RAW | unix.SOCK_CLOEXEC, unix.NETLINK_ROUTE, allow},
		{unix.AF_INET, unix.SOCK_STREAM, ipprotoMPTCP, eacces},
		{unix.AF_INET6, unix.SOCK_STREAM | flags, ipprotoMPTCP, eacces},
		{unix.AF_INET, unix.SOCK_STREAM | unix.SOCK_CLOEXEC, ipprotoMPTCP, eacces},
		{unix.AF_INET, unix.SOCK_STREAM, unix.IPPROTO_SCTP, eacces},
		{unix.AF_INET, unix.SOCK_STREAM, unix.IPPROTO_UDP, eacces},
		{unix.AF_INET, unix.SOCK_STREAM | 0x40, 0, eacces}, // a bit that isn't a flag
		{unix.AF_INET, unix.SOCK_SEQPACKET, 0, eacces},
		{unix.AF_INET6, unix.SOCK_SEQPACKET | flags, unix.IPPROTO_SCTP, eacces},
		{unix.AF_INET, unix.SOCK_RAW, unix.IPPROTO_TCP, eacces},
		{unix.AF_INET, unix.SOCK_RDM, 0, eacces},
		{unix.AF_INET, unix.SOCK_DCCP, 0, eacces},
		{unix.AF_INET, unix.SOCK_DGRAM, unix.IPPROTO_ICMP, eacces},
		{unix.AF_INET6, unix.SOCK_DGRAM, unix.IPPROTO_ICMPV6, eacces},
		{unix.AF_INET, unix.SOCK_DGRAM, unix.IPPROTO_UDPLITE, eacces},
		{unix.AF_INET, unix.SOCK_DGRAM, unix.IPPROTO_TCP, eacces},
		{unix.AF_UNIX, unix.SOCK_STREAM, 0, eacces},
		{unix.AF_UNIX, unix.SOCK_DGRAM | flags, 0, eacces},
		{unix.AF_VSOCK, unix.SOCK_STREAM, 0, noFamily},
		{unix.AF_PACKET, unix.SOCK_RAW, 0, noFamily},
		{unix.AF_ALG, unix.SOCK_SEQPACKET, 0, noFamily},
		{unix.AF_XDP, unix.SOCK_RAW, 0, noFamily},
		{unix.AF_TIPC, unix.SOCK_STREAM, 0, noFamily},
	} {
		// The high half of each argument is ignored by the kernel for int arguments; set it to show it's unread.
		got := runFilter(t, p, arch, unix.SYS_SOCKET, uint64(c.fam)|1<<40, uint64(c.typ)|1<<40, uint64(c.proto)|1<<40)
		if got != c.want {
			t.Errorf("socket(%d, %#x, %d): %#x, want %#x", c.fam, c.typ, c.proto, got, c.want)
		}
	}
	// socketpair isn't socket: allowed (an unnamed pair reaches nothing).
	if got := runFilter(t, p, arch, unix.SYS_SOCKETPAIR, unix.AF_UNIX, unix.SOCK_STREAM, 0); got != allow {
		t.Errorf("socketpair: %#x", got)
	}
}

// Pinning (#1521 and #1520), on any Linux machine, Landlock or not, so CI runs it: TCP Fast Open's
// MSG_FASTOPEN is refused in sendto, sendmsg and sendmmsg, with or without other flags, and nothing else they send
// is; prctl(PR_SET_PTRACER) is refused, and no other prctl.
func TestSendRule(t *testing.T) {
	p, err := SeccompProgram()
	if err != nil {
		t.Skip(err)
	}
	arch, _ := nativeArch()
	allow, noTFO, eperm := uint32(seccompRetAllow), unix.SECCOMP_RET_ERRNO|uint32(unix.EOPNOTSUPP), unix.SECCOMP_RET_ERRNO|uint32(unix.EPERM)
	const fo = unix.MSG_FASTOPEN
	for _, c := range []struct {
		name string
		nr   uint32
		args []uint64
		want uint32
	}{
		{"sendto MSG_FASTOPEN", unix.SYS_SENDTO, []uint64{3, 0, 1, fo, 0, 16}, noTFO},
		{"sendto MSG_FASTOPEN|MSG_NOSIGNAL", unix.SYS_SENDTO, []uint64{3, 0, 1, fo | unix.MSG_NOSIGNAL, 0, 16}, noTFO},
		{"sendto MSG_NOSIGNAL", unix.SYS_SENDTO, []uint64{3, 0, 1, unix.MSG_NOSIGNAL, 0, 16}, allow},
		{"sendto 0", unix.SYS_SENDTO, []uint64{3, 0, 1, 0, 0, 0}, allow},
		// MSG_FASTOPEN in another argument (the length, the address) isn't the flags.
		{"sendto with the bit in its length", unix.SYS_SENDTO, []uint64{3, 0, fo, 0, 0, 16}, allow},
		{"sendmsg MSG_FASTOPEN", unix.SYS_SENDMSG, []uint64{3, 0, fo}, noTFO},
		{"sendmsg MSG_FASTOPEN|MSG_DONTWAIT", unix.SYS_SENDMSG, []uint64{3, 0, fo | unix.MSG_DONTWAIT}, noTFO},
		{"sendmsg 0", unix.SYS_SENDMSG, []uint64{3, 0, 0}, allow},
		{"sendmsg with the bit where sendto's flags are", unix.SYS_SENDMSG, []uint64{3, 0, 0, fo}, allow},
		{"sendmmsg MSG_FASTOPEN", unix.SYS_SENDMMSG, []uint64{3, 0, 1, fo}, noTFO},
		{"sendmmsg 0", unix.SYS_SENDMMSG, []uint64{3, 0, 1, 0}, allow},
		{"recvfrom with the bit", unix.SYS_RECVFROM, []uint64{3, 0, 1, fo, 0, 0}, allow},
		{"prctl PR_SET_PTRACER", unix.SYS_PRCTL, []uint64{unix.PR_SET_PTRACER, 4242}, eperm},
		{"prctl PR_SET_PTRACER_ANY", unix.SYS_PRCTL, []uint64{unix.PR_SET_PTRACER, ^uint64(0)}, eperm},
		{"prctl PR_SET_NAME", unix.SYS_PRCTL, []uint64{unix.PR_SET_NAME, 0}, allow},
		{"prctl PR_SET_PDEATHSIG", unix.SYS_PRCTL, []uint64{unix.PR_SET_PDEATHSIG, 9}, allow},
		{"pidfd_getfd", unix.SYS_PIDFD_GETFD, []uint64{3, 4, 0}, eperm},
	} {
		if got := runFilter(t, p, arch, uint32(c.nr), c.args...); got != c.want {
			t.Errorf("%s: %#x, want %#x", c.name, got, c.want)
		}
	}
}

// Pinning (#1520): the launcher refuses to start unless Yama's ptrace_scope is 1 or more, which the
// pidfd_getfd and ptrace refusals rest on; and without Yama at all.
func TestCheckPtraceScope(t *testing.T) {
	dir := t.TempDir()
	defer func(p string) { ptraceScopePath = p }(ptraceScopePath)
	for v, ok := range map[string]bool{"0\n": false, "1\n": true, "2": true, "3\n": true, "x": false, "": false} {
		ptraceScopePath = filepath.Join(dir, "scope")
		if err := os.WriteFile(ptraceScopePath, []byte(v), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := CheckPtraceScope(); (err == nil) != ok {
			t.Errorf("ptrace_scope %q: %v", v, err)
		}
	}
	ptraceScopePath = filepath.Join(dir, "missing")
	if err := CheckPtraceScope(); err == nil || !strings.Contains(err.Error(), "can't read kernel.yama.ptrace_scope") {
		t.Errorf("no Yama: %v", err)
	}
}

func TestParseAllow(t *testing.T) {
	got, err := ParseAllow(" 5432,3001,5432 ")
	if err != nil || fmt.Sprint(got) != "[3001 5432]" {
		t.Errorf("ParseAllow: %v %v", got, err)
	}
	if fmt.Sprint(AllowedTCPPorts(got)) != "[443 3001 5432]" || fmt.Sprint(AllowedTCPPorts(nil)) != "[443]" {
		t.Errorf("AllowedTCPPorts: %v", AllowedTCPPorts(got))
	}
	for _, bad := range []string{"80", "0", "65536", "x", "3001,,", "3001,80"} {
		if _, err := ParseAllow(bad); err == nil {
			t.Errorf("ParseAllow(%q) accepted", bad)
		}
	}
	many := make([]string, MaxAllowedPorts+1)
	for i := range many {
		many[i] = fmt.Sprint(2000 + i)
	}
	if _, err := ParseAllow(strings.Join(many, ",")); err == nil {
		t.Error("too many ports accepted")
	}
}

// The agent requires tcp-allowlist (agent/preview-runs.js, launcherUsable).
func TestFeaturesNameTheTCPAllowlist(t *testing.T) {
	out, err := exec.Command(launcherBin, "features").Output()
	if err != nil || strings.TrimSpace(string(out)) != "tcp-allowlist" {
		t.Errorf("features: %q %v", out, err)
	}
}
