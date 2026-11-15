package main

// Integration tests: build the launcher, confine this test binary (as a probe,
// copied into the run directory) under a fake home, and check what it can
// reach. They need Landlock ABI 4 (every launch applies the TCP port rule);
// boxes run 6.8 (4). Below it they skip.

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

var launcherBin string

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "probe" {
		os.Exit(probe(os.Args[2:]))
	}
	dir, err := os.MkdirTemp("", "termag-preview-test")
	if err != nil {
		panic(err)
	}
	launcherBin = filepath.Join(dir, "termag-preview")
	if out, err := exec.Command("go", "build", "-o", launcherBin, ".").CombinedOutput(); err != nil {
		panic(fmt.Sprintf("build: %v\n%s", err, out))
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// probe runs inside the sandbox. Each check prints "<name> ok" or
// "<name> <errno>".
func probe(args []string) int {
	report := func(name string, err error) {
		if err == nil {
			fmt.Println(name, "ok")
			return
		}
		var e unix.Errno
		if errors.As(err, &e) {
			fmt.Println(name, unix.ErrnoName(e))
			return
		}
		fmt.Println(name, err)
	}
	switch args[0] {
	case "read":
		for _, p := range args[1:] {
			f, err := os.Open(p)
			if err == nil {
				if fi, _ := f.Stat(); fi != nil && fi.IsDir() {
					_, err = f.Readdirnames(-1)
				} else {
					_, err = io.ReadAll(f)
				}
				f.Close()
			}
			report("read "+p, err)
		}
	case "write":
		for _, p := range args[1:] {
			report("write "+p, os.WriteFile(p, []byte("planted"), 0o644))
		}
	case "mkdir":
		for _, p := range args[1:] {
			report("mkdir "+p, os.Mkdir(p, 0o755))
		}
	case "fds":
		// Raw system calls: os.Open would start this probe's own poller and
		// add its epoll and eventfd descriptors to the list.
		fd, err := unix.Open("/proc/self/fd", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
		if err != nil {
			report("fds", err)
			break
		}
		buf := make([]byte, 4096)
		n, _ := unix.Getdents(fd, buf)
		_, _, names := unix.ParseDirent(buf[:n], -1, nil)
		var fds []string
		for _, name := range names {
			if name == strconv.Itoa(fd) {
				continue
			}
			// This probe's own Go runtime opens its cgroup's cpu.max after exec, to size GOMAXPROCS to a
			// CPU limit, and keeps it open to watch it (a runner's cgroup has one): not a descriptor the
			// launcher passed on. Anything else is.
			if l, err := os.Readlink("/proc/self/fd/" + name); err == nil && strings.HasPrefix(l, "/sys/fs/cgroup/") && strings.HasSuffix(l, "/cpu.max") {
				continue
			}
			fds = append(fds, name)
		}
		sort.Strings(fds)
		fmt.Println("fds", strings.Join(fds, ","))
		if len(args) > 1 && args[1] == "links" {
			// What each one is, for a failure's message.
			var links []string
			for _, d := range fds {
				l, _ := os.Readlink("/proc/self/fd/" + d)
				links = append(links, d+"="+l)
			}
			fmt.Fprintln(os.Stderr, "fd links:", strings.Join(links, " "))
		}
	case "env":
		env := os.Environ()
		sort.Strings(env)
		fmt.Println("env", strings.Join(env, "|"))
	case "unix":
		// A real connect to each socket path: the tmux server, Docker, the
		// user bus, the agent's socket. socket() itself is what's refused.
		for _, p := range args[1:] {
			fd, err := unix.Socket(unix.AF_UNIX, unix.SOCK_STREAM, 0)
			if err == nil {
				err = unix.Connect(fd, &unix.SockaddrUnix{Name: p})
				unix.Close(fd)
			}
			report("unix "+p, err)
		}
		_, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM, 0)
		report("socketpair", err)
	case "syscalls":
		var params [120]byte
		_, _, e := unix.Syscall(unix.SYS_IO_URING_SETUP, 4, uintptr(unsafe.Pointer(&params)), 0)
		report("io_uring_setup", errnoOrNil(e))
		var cl [88]byte
		_, _, e = unix.Syscall(unix.SYS_CLONE3, uintptr(unsafe.Pointer(&cl)), 88, 0)
		report("clone3", errnoOrNil(e))
		_, _, e = unix.Syscall(unix.SYS_PTRACE, unix.PTRACE_ATTACH, uintptr(os.Getppid()), 0)
		report("ptrace", errnoOrNil(e))
		report("unshare", unix.Unshare(unix.CLONE_NEWUSER))
		_, _, e = unix.Syscall(unix.SYS_KEYCTL, 0, 0, 0)
		report("keyctl", errnoOrNil(e))
	case "prctl":
		// prctl(PR_SET_PTRACER, the parent): refused, so no same-user process can be let in to take this one's
		// descriptors (pidfd_getfd, refused too). PR_SET_NAME, any other prctl, still works.
		report("prctl PR_SET_PTRACER", unix.Prctl(unix.PR_SET_PTRACER, uintptr(os.Getppid()), 0, 0, 0))
		name := []byte("probe\x00")
		report("prctl PR_SET_NAME", unix.Prctl(unix.PR_SET_NAME, uintptr(unsafe.Pointer(&name[0])), 0, 0, 0))
	case "mptcp":
		// An IPPROTO_MPTCP stream socket: Landlock's TCP rules don't see it, and it falls back to TCP with an
		// ordinary server, so it must be refused outright (Cursor Security Agent, #1519).
		for _, a := range args[1:] {
			host, portS, _ := net.SplitHostPort(a)
			port, _ := strconv.Atoi(portS)
			ip := net.ParseIP(host)
			fam, sa := unix.AF_INET, unix.Sockaddr(nil)
			if ip4 := ip.To4(); ip4 != nil {
				sa4 := &unix.SockaddrInet4{Port: port}
				copy(sa4.Addr[:], ip4)
				sa = sa4
			} else {
				fam = unix.AF_INET6
				sa6 := &unix.SockaddrInet6{Port: port}
				copy(sa6.Addr[:], ip.To16())
				sa = sa6
			}
			fd, err := unix.Socket(fam, unix.SOCK_STREAM, 262)
			if err == nil {
				err = unix.Connect(fd, sa)
				unix.Close(fd)
			}
			report("mptcp "+a, err)
		}
	case "sock":
		// sock <how> <family> <type> <protocol> <addr>...: socket(family, type, protocol), then for each addr a
		// connect (how "connect"), or a TCP Fast Open sendto (how "fastopen"), which connects without connect().
		how := args[1]
		nums := make([]int, 3)
		for i := range nums {
			nums[i], _ = strconv.Atoi(args[2+i])
		}
		name := fmt.Sprintf("sock %s %d/%#x/%d", how, nums[0], nums[1], nums[2])
		for _, a := range args[5:] {
			fd, err := unix.Socket(nums[0], nums[1], nums[2])
			if err == nil && a != "-" {
				sa := sockaddrOf(a)
				switch how {
				case "connect":
					err = unix.Connect(fd, sa)
				case "fastopen":
					err = unix.Sendto(fd, []byte("x"), unix.MSG_FASTOPEN, sa)
				case "fastopen-sendmsg":
					_, err = unix.SendmsgN(fd, []byte("x"), nil, sa, unix.MSG_FASTOPEN)
				case "fastopen-sendmmsg":
					err = sendmmsgFastOpen(fd, sa)
				}
				if err == nil && strings.HasPrefix(how, "fastopen") {
					// Sent, so connected: whether it got there is the peer's to say.
					_, err = unix.Getpeername(fd)
				}
			}
			if err == nil {
				unix.Close(fd)
			}
			report(name+" "+a, err)
		}
	case "tcp":
		for _, a := range args[1:] {
			c, err := net.Dial("tcp", a)
			if err == nil {
				c.Close()
			}
			var op *net.OpError
			if errors.As(err, &op) {
				err = op.Err
				var se *os.SyscallError
				if errors.As(err, &se) {
					err = se.Err
				}
			}
			report("tcp "+a, err)
		}
	}
	return 0
}

// sendmmsgFastOpen is sendmmsg(fd, one message to sa, MSG_FASTOPEN), IPv4 only: x/sys has no wrapper.
func sendmmsgFastOpen(fd int, sa unix.Sockaddr) error {
	in4, ok := sa.(*unix.SockaddrInet4)
	if !ok {
		return unix.EAFNOSUPPORT
	}
	raw := unix.RawSockaddrInet4{Family: unix.AF_INET, Addr: in4.Addr}
	raw.Port = uint16(in4.Port>>8) | uint16(in4.Port&0xff)<<8
	payload := []byte("x")
	iov := unix.Iovec{Base: &payload[0]}
	iov.SetLen(1)
	var msg struct {
		hdr unix.Msghdr
		n   uint32
		_   [4]byte
	}
	msg.hdr.Name = (*byte)(unsafe.Pointer(&raw))
	msg.hdr.Namelen = unix.SizeofSockaddrInet4
	msg.hdr.Iov = &iov
	msg.hdr.SetIovlen(1)
	_, _, e := unix.Syscall6(unix.SYS_SENDMMSG, uintptr(fd), uintptr(unsafe.Pointer(&msg)), 1, unix.MSG_FASTOPEN, 0, 0)
	if e != 0 {
		return e
	}
	return nil
}

// sockaddrOf is host:port as a socket address, IPv4 or IPv6.
func sockaddrOf(a string) unix.Sockaddr {
	host, portS, _ := net.SplitHostPort(a)
	port, _ := strconv.Atoi(portS)
	ip := net.ParseIP(host)
	if ip4 := ip.To4(); ip4 != nil {
		sa := &unix.SockaddrInet4{Port: port}
		copy(sa.Addr[:], ip4)
		return sa
	}
	sa := &unix.SockaddrInet6{Port: port}
	copy(sa.Addr[:], ip.To16())
	return sa
}

func errnoOrNil(e unix.Errno) error {
	if e == 0 {
		return nil
	}
	return e
}

type fixture struct {
	l       Layout
	work    string
	probe   string
	outside string // a file outside the home, standing in for /tmp's
}

func requireLandlock(t *testing.T) {
	if abi := LandlockABI(); abi < MinABI {
		t.Skipf("landlock ABI %d", abi)
	}
}

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

// newFixture makes a fake home with secrets, a checkout and a run directory,
// and copies this test binary into the run directory as the probe.
func newFixture(t *testing.T) *fixture {
	// Every launch applies the TCP port rule, which is ABI 4 (Devin, #1519).
	if abi := LandlockABI(); abi < 4 {
		t.Skipf("landlock ABI %d: launch needs 4", abi)
	}
	home := t.TempDir()
	f := &fixture{l: Layout{
		Home:     home,
		Checkout: filepath.Join(home, "termag/projects/app"),
		Run:      filepath.Join(home, ".local/state/termag-preview/r1"),
	}}
	f.work = filepath.Join(f.l.Run, "work")
	for _, p := range []string{".aws/credentials", ".ssh/id_ed25519", ".config/gh/hosts.yml", "src/termag/agent/agent.config.json", ".npmrc", "termag/projects/other/.env"} {
		write(t, filepath.Join(home, p), "secret")
	}
	write(t, filepath.Join(f.l.Checkout, "package.json"), "{}")
	write(t, filepath.Join(f.l.Checkout, ".git/config"), "[core]")
	write(t, filepath.Join(f.l.Checkout, ".env"), "SECRET=1")
	write(t, filepath.Join(f.l.Checkout, "node_modules/pkg/index.js"), "module.exports = 1")
	write(t, filepath.Join(home, ".npm/_cacache/index"), "cache")
	if err := os.MkdirAll(filepath.Join(f.l.Run, "tmp"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(f.work, 0o700); err != nil {
		t.Fatal(err)
	}
	f.probe = filepath.Join(f.work, "probe")
	self, _ := os.Executable()
	b, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.probe, b, 0o755); err != nil {
		t.Fatal(err)
	}
	// A planted symlink in the run directory to a secret.
	if err := os.Symlink(filepath.Join(home, ".aws/credentials"), filepath.Join(f.work, "leak")); err != nil {
		t.Fatal(err)
	}
	outside, err := os.CreateTemp("", "outside")
	if err != nil {
		t.Fatal(err)
	}
	outside.Close()
	f.outside = outside.Name()
	t.Cleanup(func() { os.Remove(f.outside) })
	return f
}

func (f *fixture) env() []string {
	return []string{"PATH=/usr/bin:/bin", "HOME=" + f.l.Home, "TMPDIR=" + filepath.Join(f.l.Run, "tmp")}
}

// launch runs the probe confined and returns its output, line by line.
func (f *fixture) launch(t *testing.T, extra []string, args ...string) map[string]string {
	t.Helper()
	argv := []string{"launch", "--home", f.l.Home, "--checkout", f.l.Checkout, "--run", f.l.Run}
	argv = append(argv, extra...)
	for _, e := range f.env() {
		argv = append(argv, "--env", e)
	}
	argv = append(append(argv, "--", f.probe, "probe"), args...)
	cmd := exec.Command(launcherBin, argv...)
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			t.Fatalf("launch: %v\n%s", err, ee.Stderr)
		}
		t.Fatal(err)
	}
	res := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		i := strings.LastIndex(line, " ")
		if i > 0 {
			res[line[:i]] = line[i+1:]
		}
	}
	return res
}

func expect(t *testing.T, res map[string]string, want map[string]string) {
	t.Helper()
	for k, v := range want {
		if res[k] != v {
			t.Errorf("%s: got %q, want %q", k, res[k], v)
		}
	}
}

// Pinning (SR9, I11): a confined app can't read the rest of the home
// directory, /tmp, another checkout, or a secret through a symlink.
func TestConfinedReads(t *testing.T) {
	f := newFixture(t)
	h := f.l.Home
	res := f.launch(t, nil, "read",
		h+"/.aws/credentials", h+"/.ssh/id_ed25519", h+"/.config/gh/hosts.yml",
		h+"/src/termag/agent/agent.config.json", h+"/.npmrc", h+"/termag/projects/other/.env",
		f.outside, f.work+"/leak", "/etc/shadow",
		f.l.Checkout+"/.git/config", f.l.Checkout+"/.env",
		f.l.Checkout+"/node_modules/pkg/index.js", h+"/.npm/_cacache/index", "/etc/hosts", "/proc/self/status", f.l.Checkout)
	expect(t, res, map[string]string{
		"read " + h + "/.aws/credentials":                   "EACCES",
		"read " + h + "/.ssh/id_ed25519":                    "EACCES",
		"read " + h + "/.config/gh/hosts.yml":               "EACCES",
		"read " + h + "/src/termag/agent/agent.config.json": "EACCES",
		"read " + h + "/.npmrc":                             "EACCES",
		"read " + h + "/termag/projects/other/.env":         "EACCES",
		"read " + f.outside:                                 "EACCES",
		"read " + f.work + "/leak":                          "EACCES",
		"read /etc/shadow":                                  "EACCES",
		// The default grant is the checkout's node_modules only.
		"read " + f.l.Checkout + "/.git/config":               "EACCES",
		"read " + f.l.Checkout + "/.env":                      "EACCES",
		"read " + f.l.Checkout + "/node_modules/pkg/index.js": "ok",
		// Listing the checkout root is allowed (esbuild needs it); reading
		// its files isn't.
		"read " + f.l.Checkout:               "ok",
		"read " + h + "/.npm/_cacache/index": "ok",
		"read /etc/hosts":                    "ok",
		"read /proc/self/status":             "ok",
	})
}

// Pinning (SR9, I11): nothing in the checkout is writable, under any grant.
func TestConfinedCannotWriteTheCheckout(t *testing.T) {
	f := newFixture(t)
	c := f.l.Checkout
	for _, grant := range []string{"node-modules", "none"} {
		res := f.launch(t, []string{"--checkout-grant", grant}, "write",
			c+"/package.json", c+"/.git/config", c+"/.envrc", c+"/node_modules/pkg/index.js",
			f.l.Home+"/.npm/_cacache/index", f.work+"/out.js", f.l.Run+"/tmp/x")
		expect(t, res, map[string]string{
			"write " + c + "/package.json":               "EACCES",
			"write " + c + "/.git/config":                "EACCES",
			"write " + c + "/.envrc":                     "EACCES",
			"write " + c + "/node_modules/pkg/index.js":  "EACCES",
			"write " + f.l.Home + "/.npm/_cacache/index": "EACCES",
			"write " + f.work + "/out.js":                "ok",
			"write " + f.l.Run + "/tmp/x":                "ok",
		})
		res = f.launch(t, []string{"--checkout-grant", grant}, "mkdir", c+"/.git/hooks", c+"/dist", c+"/.next")
		for k, v := range res {
			if v != "EACCES" {
				t.Errorf("%s %s: %s", grant, k, v)
			}
		}
	}
}

// Pinning (SR9): only descriptors 0 to 2, and only the allowlisted
// environment, reach the app.
func TestConfinedDescriptorsAndEnvironment(t *testing.T) {
	f := newFixture(t)
	// Hand the launcher an extra descriptor, as a leaky parent would.
	r, w, _ := os.Pipe()
	defer r.Close()
	defer w.Close()
	argv := []string{"launch", "--home", f.l.Home, "--checkout", f.l.Checkout, "--run", f.l.Run}
	for _, e := range f.env() {
		argv = append(argv, "--env", e)
	}
	cmd := exec.Command(launcherBin, append(argv, "--", f.probe, "probe", "fds")...)
	cmd.ExtraFiles = []*os.File{r, w}
	cmd.Env = append(os.Environ(), "GITHUB_TOKEN=leak", "SSH_AUTH_SOCK=/leak", "TMUX=/leak")
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(out)); got != "fds 0,1,2" {
		// Say what the extra descriptor is (a runner's, the runtime's, the launcher's).
		why := exec.Command(launcherBin, append(argv, "--", f.probe, "probe", "fds", "links")...)
		why.ExtraFiles = []*os.File{r, w}
		var stderr strings.Builder
		why.Stderr = &stderr
		_ = why.Run()
		t.Errorf("got %q; %s", got, strings.TrimSpace(stderr.String()))
	}
	cmd = exec.Command(launcherBin, append(argv, "--", f.probe, "probe", "env")...)
	cmd.Env = append(os.Environ(), "GITHUB_TOKEN=leak", "SSH_AUTH_SOCK=/leak", "TMUX=/leak", "AWS_PROFILE=leak")
	out, err = cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	// The agent's variables and the launcher's own (FixedEnv), nothing else.
	want := append(f.env(), FixedEnv...)
	sort.Strings(want)
	if got := strings.TrimSpace(string(out)); got != "env "+strings.Join(want, "|") {
		t.Errorf("got %q", got)
	}
}

// Pinning (SR9): no new Unix socket, no io_uring, no clone3 (which could
// leave the preview cgroup), no ptrace, no namespaces.
func TestConfinedSyscalls(t *testing.T) {
	f := newFixture(t)
	// A listening socket of the owner's, standing in for the agent's, plus
	// the box's real ones where this host has them.
	agentSock := filepath.Join(t.TempDir(), "agent.sock")
	ln, err := net.Listen("unix", agentSock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	paths := []string{agentSock}
	for _, p := range []string{fmt.Sprintf("/tmp/tmux-%d/default", os.Getuid()), "/var/run/docker.sock", fmt.Sprintf("/run/user/%d/bus", os.Getuid())} {
		if _, err := os.Stat(p); err == nil {
			paths = append(paths, p)
		} else {
			t.Logf("no %s on this host; not tried", p)
		}
	}
	// The owner reaches it; the confined app doesn't.
	if c, err := net.Dial("unix", agentSock); err != nil {
		t.Fatalf("owner can't reach the stand-in: %v", err)
	} else {
		c.Close()
	}
	res := f.launch(t, nil, append([]string{"unix"}, paths...)...)
	want := map[string]string{"socketpair": "ok"}
	for _, p := range paths {
		want["unix "+p] = "EACCES"
	}
	expect(t, res, want)
	res = f.launch(t, nil, "syscalls")
	expect(t, res, map[string]string{
		"io_uring_setup": "ENOSYS", "clone3": "ENOSYS", "ptrace": "EPERM", "unshare": "EPERM", "keyctl": "EPERM",
	})
}

// Another process's /proc/<pid>/environ is ptrace-class access, which
// Landlock refuses for processes outside the domain.
func TestConfinedCannotReadAnotherProcessesEnviron(t *testing.T) {
	f := newFixture(t)
	other := exec.Command("sleep", "30")
	other.Env = []string{"SECRET=1"}
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	defer other.Process.Kill()
	p := fmt.Sprintf("/proc/%d/environ", other.Process.Pid)
	expect(t, f.launch(t, nil, "read", p), map[string]string{"read " + p: "EACCES"})
}

// Pinning (SR9, loopback decided 2026-11-04): TCP connect reaches only 443
// and the declared ports. An undeclared loopback port (an owner's debugger,
// say) gets EACCES, a declared one connects, and port 80 (where IMDS listens)
// is refused either way.
func TestConfinedTCP(t *testing.T) {
	f := newFixture(t)
	listen := func() net.Listener {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				c.Close()
			}
		}()
		return ln
	}
	declared, undeclared := listen(), listen()
	defer declared.Close()
	defer undeclared.Close()
	dPort := declared.Addr().(*net.TCPAddr).Port
	// The owner reaches both.
	for _, ln := range []net.Listener{declared, undeclared} {
		c, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			t.Fatalf("owner: %v", err)
		}
		c.Close()
	}
	res := f.launch(t, []string{"--allow-tcp", strconv.Itoa(dPort)}, "tcp",
		declared.Addr().String(), undeclared.Addr().String(), "[::1]:"+strconv.Itoa(undeclared.Addr().(*net.TCPAddr).Port),
		"127.0.0.1:80", "127.0.0.1:443")
	expect(t, res, map[string]string{
		"tcp " + declared.Addr().String():                                  "ok",
		"tcp " + undeclared.Addr().String():                                "EACCES",
		"tcp [::1]:" + strconv.Itoa(undeclared.Addr().(*net.TCPAddr).Port): "EACCES",
		"tcp 127.0.0.1:80":                                                 "EACCES",
		// Allowed, so the kernel answers: nothing listens there.
		"tcp 127.0.0.1:443": "ECONNREFUSED",
	})
	// Undeclared, the same port is refused.
	res = f.launch(t, nil, "tcp", declared.Addr().String())
	expect(t, res, map[string]string{"tcp " + declared.Addr().String(): "EACCES"})
	// TCP Fast Open connects from a send, not connect(), which Landlock's rule didn't see on 6.8.0-1067-aws: seccomp
	// refuses it outright (sendRule, #1637). And MPTCP, which the rule doesn't cover, can't be made at all (socketRule).
	res = f.launch(t, []string{"--allow-tcp", strconv.Itoa(dPort)}, "sock", "fastopen", "2", "1", "0", declared.Addr().String(), undeclared.Addr().String())
	expect(t, res, map[string]string{
		// Refused outright, declared or not (seccomp's sendRule, #1637): a Fast Open send connected past
		// Landlock's rule on 6.8.0-1067-aws (#1521). An app falls back to connect(), which the rule decides.
		"sock fastopen 2/0x1/0 " + declared.Addr().String():   "ENOTSUP",
		"sock fastopen 2/0x1/0 " + undeclared.Addr().String(): "ENOTSUP",
	})
	res = f.launch(t, []string{"--allow-tcp", strconv.Itoa(dPort)}, "mptcp", undeclared.Addr().String())
	expect(t, res, map[string]string{"mptcp " + undeclared.Addr().String(): "EACCES"})
}

func TestLaunchRefusesAnUnlistedVariable(t *testing.T) {
	f := newFixture(t)
	cmd := exec.Command(launcherBin, "launch", "--home", f.l.Home, "--checkout", f.l.Checkout, "--run", f.l.Run,
		"--env", "PATH=/usr/bin", "--env", "HOME="+f.l.Home, "--env", "TMPDIR=/x",
		"--env", "GITHUB_TOKEN=x", "--", "/bin/true")
	if out, err := cmd.CombinedOutput(); err == nil || !strings.Contains(string(out), "GITHUB_TOKEN") {
		t.Errorf("started: %v %s", err, out)
	}
}

// Pinning (SR9): the checkout root, a cache directory and a toolchain
// directory, each replaced by a symlink (to ., to .git/hooks, to ~/.aws),
// make the launcher refuse to start, and their targets never reach the
// ruleset.
func TestSymlinkedRulePathsRefuseTheStart(t *testing.T) {
	requireLandlock(t)
	cases := []struct {
		name   string
		link   func(home, checkout string) (link, target string)
		grant  CheckoutGrant
		reason string
	}{
		{"checkout -> .", func(h, c string) (string, string) { return c, "." }, CheckoutNodeModules, "symlink"},
		{"checkout -> ~/.aws", func(h, c string) (string, string) { return c, filepath.Join(h, ".aws") }, CheckoutNodeModules, "symlink"},
		{"node_modules -> .git/hooks", func(h, c string) (string, string) {
			return filepath.Join(c, "node_modules"), filepath.Join(c, ".git/hooks")
		}, CheckoutNodeModules, "symlink"},
		{"a parent of the checkout -> ~/.aws", func(h, c string) (string, string) {
			return filepath.Dir(c), filepath.Join(h, ".aws")
		}, CheckoutNodeModules, "symlink"},
		{"~/.npm -> ~/.aws", func(h, c string) (string, string) { return filepath.Join(h, ".npm"), filepath.Join(h, ".aws") }, CheckoutNodeModules, "symlink"},
		{"~/.nvm/versions -> ~/.ssh", func(h, c string) (string, string) {
			return filepath.Join(h, ".nvm/versions"), filepath.Join(h, ".ssh")
		}, CheckoutNodeModules, "symlink"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			l := Layout{Home: home, Checkout: filepath.Join(home, "p/app"), Run: filepath.Join(home, "run")}
			for _, d := range []string{".aws", ".ssh", "p/app/.git/hooks", "p/app/node_modules", "run", "elsewhere/app"} {
				os.MkdirAll(filepath.Join(home, d), 0o755)
			}
			link, target := tc.link(home, l.Checkout)
			os.RemoveAll(link)
			os.MkdirAll(filepath.Dir(link), 0o755)
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
			rs, err := OpenRuleset(AppGrants(l, tc.grant), home)
			if err == nil {
				desc := rs.Describe()
				rs.Close()
				t.Fatalf("started with:\n%s", desc)
			}
			if !strings.Contains(err.Error(), tc.reason) {
				t.Errorf("error %q doesn't say %q", err, tc.reason)
			}
		})
	}
}

// The stock box's system symlinks (resolv.conf into /run/systemd/resolve,
// owned by systemd-resolve; localtime into /usr/share/zoneinfo; /lib and
// /bin into /usr) are accepted.
func TestStockSystemPathsAreAccepted(t *testing.T) {
	requireLandlock(t)
	rs, err := OpenRuleset(systemGrants(), "/home/nobody-here")
	if err != nil {
		t.Fatal(err)
	}
	defer rs.Close()
	t.Log("\n" + rs.Describe())
}

// A "system" path whose target the user owns is refused.
func TestSystemPathOwnedByTheUserIsRefused(t *testing.T) {
	requireLandlock(t)
	dir := t.TempDir()
	if _, err := openGrant(Grant{Path: dir, Origin: FromSystem, Access: ReadExec}, "/home/nobody-here", os.Getuid()); err == nil {
		t.Fatal("accepted a user-owned system path")
	}
	link := filepath.Join(t.TempDir(), "resolv.conf")
	os.Symlink(filepath.Join(dir, "x"), link)
	os.WriteFile(filepath.Join(dir, "x"), nil, 0o644)
	if _, err := openGrant(Grant{Path: link, Origin: FromSystem, Access: ReadFile}, "/home/nobody-here", os.Getuid()); err == nil {
		t.Fatal("accepted a system symlink into a user-owned file")
	}
}

// A refused connect can be told from any other EACCES: the launcher names
// the allowed ports in the run's log at every start, port 80 can't be
// declared, and there is no flag to turn the IMDS rule off.
func TestTCPNoticeAndNoIMDSFlag(t *testing.T) {
	f := newFixture(t)
	argv := []string{"launch", "--home", f.l.Home, "--checkout", f.l.Checkout, "--run", f.l.Run}
	for _, e := range f.env() {
		argv = append(argv, "--env", e)
	}
	out, err := exec.Command(launcherBin, append(append(append([]string{}, argv...), "--allow-tcp", "5432,3001"), "--", "/bin/true")...).CombinedOutput()
	if err != nil {
		t.Fatalf("%v %s", err, out)
	}
	if !strings.Contains(string(out), TCPNotice([]int{443, 3001, 5432})) || !strings.Contains(string(out), TCPNoticePrefix+"443, 3001, 5432 ") {
		t.Errorf("no TCP notice in:\n%s", out)
	}
	out, err = exec.Command(launcherBin, append(append(append([]string{}, argv...), "--allow-tcp", "3001,80"), "--", "/bin/true")...).CombinedOutput()
	if err == nil || !strings.Contains(string(out), "port 80 can't be allowed") {
		t.Errorf("--allow-tcp 80 accepted: %v %s", err, out)
	}
	out, err = exec.Command(launcherBin, append(append([]string{}, argv[:7]...), "--imds", "cgroup", "--", "/bin/true")...).CombinedOutput()
	if err == nil || !strings.Contains(string(out), "flag provided but not defined: -imds") {
		t.Errorf("--imds accepted: %v %s", err, out)
	}
}

// Pinning (SR9, the 2026-11-02 IMDS decision): a confined process gets no
// instance metadata, over IPv4 or IPv6, while the owner's own process does.
// Needs an EC2 host whose IMDS answers the owner; skipped elsewhere (CI).
func TestConfinedIMDS(t *testing.T) {
	f := newFixture(t)
	c, err := net.DialTimeout("tcp", "169.254.169.254:80", time.Second)
	if err != nil {
		t.Skipf("IMDS doesn't answer this host's owner (%v): not an EC2 box", err)
	}
	c.Close()
	res := f.launch(t, nil, "tcp", "169.254.169.254:80", "[fd00:ec2::254]:80")
	expect(t, res, map[string]string{"tcp 169.254.169.254:80": "EACCES", "tcp [fd00:ec2::254]:80": "EACCES"})
}

// Pinning: the probe fails closed. An address that accepts is a refusal to
// start; refused, unreachable and timed-out ones aren't.
func TestProbeRefusesWhenMetadataAnswers(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	err = probeAddrs([]string{"127.0.0.1:1", ln.Addr().String()}, time.Second)
	if err == nil || !strings.Contains(err.Error(), "is reachable from this process; refusing to start") {
		t.Errorf("probe of a listening address: %v", err)
	}
	if err := probeAddrs([]string{"127.0.0.1:1"}, time.Second); err != nil {
		t.Errorf("probe of a closed port: %v", err)
	}
}

// The command resolves against the app's PATH from inside the work copy, so a
// relative entry (./node_modules/.bin) finds the copy's tools (Devin, #1519).
func TestLaunchResolvesRelativePathInTheWorkCopy(t *testing.T) {
	f := newFixture(t)
	write(t, filepath.Join(f.work, "bin/hello"), "#!/bin/sh\necho hello-from-work\n")
	os.Chmod(filepath.Join(f.work, "bin/hello"), 0o755)
	argv := []string{"launch", "--home", f.l.Home, "--checkout", f.l.Checkout, "--run", f.l.Run,
		"--env", "PATH=./bin:/usr/bin:/bin", "--env", "HOME=" + f.l.Home, "--env", "TMPDIR=" + filepath.Join(f.l.Run, "tmp"), "--", "hello"}
	out, err := exec.Command(launcherBin, argv...).CombinedOutput()
	if err != nil || !strings.Contains(string(out), "hello-from-work") {
		t.Errorf("%v\n%s", err, out)
	}
}

// Pinning (Cursor Security Agent, #1519): an MPTCP stream socket, which Landlock's TCP rules don't cover on
// 6.8, is refused, so it can't reach instance metadata or a port the rules refuse to TCP.
func TestConfinedMPTCPRefused(t *testing.T) {
	f := newFixture(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	targets := []string{"169.254.169.254:80", "127.0.0.1:80", ln.Addr().String()}
	res := f.launch(t, nil, append([]string{"mptcp"}, targets...)...)
	for _, a := range targets {
		if res["mptcp "+a] != "EACCES" {
			t.Errorf("mptcp %s: got %q, want EACCES", a, res["mptcp "+a])
		}
	}
}

// The probe also tries MPTCP, so a filter gap there would refuse the start (Cursor Security Agent, #1519).
func TestProbeTriesMPTCP(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if !mptcpConnects(ln.Addr().String(), time.Second) {
		t.Skip("this kernel has no MPTCP")
	}
	if mptcpConnects("127.0.0.1:1", time.Second) {
		t.Error("a closed port read as reachable")
	}
	if err := probeAddrs([]string{ln.Addr().String()}, time.Second); err == nil || !strings.Contains(err.Error(), "(MPTCP) is reachable from this process; refusing to start") {
		t.Errorf("probe of a listening address: %v", err)
	}
	// Both of IMDS's addresses, and over IPv6 too.
	if strings.Join(imdsAddrs, " ") != "169.254.169.254:80 [fd00:ec2::254]:80" {
		t.Errorf("probed %v", imdsAddrs)
	}
	if ln6, err := net.Listen("tcp", "[::1]:0"); err == nil {
		defer ln6.Close()
		if err := probeAddrs([]string{"127.0.0.1:1", ln6.Addr().String()}, time.Second); err == nil || !strings.Contains(err.Error(), ln6.Addr().String()+" (MPTCP) is reachable") {
			t.Errorf("probe of a listening IPv6 address: %v", err)
		}
	}
}

// Pinning (Cursor Security Agent, #1519; seccomp.go socketRule): on the real kernel, a confined app makes only the
// sockets Landlock's rules cover, TCP, plus UDP for DNS. MPTCP and SCTP, which Landlock doesn't see, are refused
// with or without SOCK_NONBLOCK and SOCK_CLOEXEC; so are raw, seqpacket and ICMP sockets, and every family but
// IPv4, IPv6 and netlink. TCP Fast Open, which connects from a send, is refused outright (sendRule, #1637).
func TestConfinedSocketsAreOnlyTCPAndUDP(t *testing.T) {
	f := newFixture(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	canary := ln.Addr().String()
	const flags = unix.SOCK_NONBLOCK | unix.SOCK_CLOEXEC
	type c struct {
		fam, typ, proto int
		how, addr, want string
	}
	cases := []c{
		{unix.AF_INET, unix.SOCK_STREAM, 0, "connect", "-", "ok"},
		{unix.AF_INET, unix.SOCK_STREAM | flags, unix.IPPROTO_TCP, "connect", "-", "ok"},
		{unix.AF_INET6, unix.SOCK_STREAM, unix.IPPROTO_TCP, "connect", "-", "ok"},
		{unix.AF_INET, unix.SOCK_DGRAM, 0, "connect", "-", "ok"},
		{unix.AF_INET6, unix.SOCK_DGRAM | flags, unix.IPPROTO_UDP, "connect", "-", "ok"},
		{unix.AF_NETLINK, unix.SOCK_RAW, unix.NETLINK_ROUTE, "connect", "-", "ok"},
		{unix.AF_INET, unix.SOCK_STREAM, ipprotoMPTCP, "connect", "169.254.169.254:80", "EACCES"},
		{unix.AF_INET6, unix.SOCK_STREAM, ipprotoMPTCP, "connect", "[fd00:ec2::254]:80", "EACCES"},
		{unix.AF_INET, unix.SOCK_STREAM | flags, ipprotoMPTCP, "connect", "-", "EACCES"},
		{unix.AF_INET6, unix.SOCK_STREAM | unix.SOCK_CLOEXEC, ipprotoMPTCP, "connect", "-", "EACCES"},
		{unix.AF_INET, unix.SOCK_STREAM, unix.IPPROTO_SCTP, "connect", "-", "EACCES"},
		{unix.AF_INET, unix.SOCK_SEQPACKET, 0, "connect", "-", "EACCES"},
		{unix.AF_INET6, unix.SOCK_SEQPACKET, unix.IPPROTO_SCTP, "connect", "-", "EACCES"},
		{unix.AF_INET, unix.SOCK_RAW, unix.IPPROTO_TCP, "connect", "-", "EACCES"},
		{unix.AF_INET, unix.SOCK_DGRAM, unix.IPPROTO_ICMP, "connect", "-", "EACCES"},
		{unix.AF_INET, unix.SOCK_DGRAM, unix.IPPROTO_UDPLITE, "connect", "-", "EACCES"},
		{unix.AF_VSOCK, unix.SOCK_STREAM, 0, "connect", "-", "EAFNOSUPPORT"},
		{unix.AF_ALG, unix.SOCK_SEQPACKET, 0, "connect", "-", "EAFNOSUPPORT"},
		{unix.AF_PACKET, unix.SOCK_RAW, 0, "connect", "-", "EAFNOSUPPORT"},
		// TCP Fast Open connects from a send, which Landlock's connect rule doesn't see on every 6.8 build (#1521: 6.8.0-1067-aws let it through; 1069 refuses): seccomp refuses MSG_FASTOPEN outright, as a kernel
		// with client TFO off does, so a library falls back to connect(). To IMDS, and to a loopback canary on a
		// port the rule allows, so the refusal is seccomp's whatever the kernel's Landlock does. EOPNOTSUPP is
		// ENOTSUP on Linux (95), which is the name the probe prints.
		{unix.AF_INET, unix.SOCK_STREAM, 0, "fastopen", "169.254.169.254:80", "ENOTSUP"},
		{unix.AF_INET, unix.SOCK_STREAM, 0, "fastopen-sendmsg", "169.254.169.254:80", "ENOTSUP"},
		{unix.AF_INET, unix.SOCK_STREAM, 0, "fastopen-sendmmsg", "169.254.169.254:80", "ENOTSUP"},
		{unix.AF_INET, unix.SOCK_STREAM, 0, "fastopen", canary, "ENOTSUP"},
		{unix.AF_INET, unix.SOCK_STREAM | unix.SOCK_NONBLOCK, 0, "fastopen-sendmsg", canary, "ENOTSUP"},
		{unix.AF_INET, unix.SOCK_STREAM, 0, "fastopen-sendmmsg", canary, "ENOTSUP"},
		// A plain connect to the canary meets the TCP rule: an undeclared loopback port, refused.
		{unix.AF_INET, unix.SOCK_STREAM, 0, "connect", canary, "EACCES"},
	}
	tfoOn := clientTFOOn()
	if !tfoOn {
		t.Log("client TCP Fast Open is off here (net.ipv4.tcp_fastopen), so the kernel refuses Fast Open sends itself: the fastopen cases are skipped, as they'd pass with or without the seccomp rule; TestSendRule pins it")
	}
	for _, k := range cases {
		if strings.HasPrefix(k.how, "fastopen") && !tfoOn {
			continue
		}
		res := f.launch(t, nil, "sock", k.how, strconv.Itoa(k.fam), strconv.Itoa(k.typ), strconv.Itoa(k.proto), k.addr)
		key := fmt.Sprintf("sock %s %d/%#x/%d %s", k.how, k.fam, k.typ, k.proto, k.addr)
		if res[key] != k.want {
			t.Errorf("%s: got %q, want %s", key, res[key], k.want)
		}
	}
}

// Pinning (#1520), on the real kernel: a confined app can't name a ptracer for itself, which with
// pidfd_getfd would let a same-user process copy a confined listener's socket; any other prctl still works.
func TestConfinedPtracerRefused(t *testing.T) {
	f := newFixture(t)
	expect(t, f.launch(t, nil, "prctl"), map[string]string{"prctl PR_SET_PTRACER": "EPERM", "prctl PR_SET_NAME": "ok"})
}

// The probe's TCP Fast Open check, unconfined: a Fast Open send to a listener connects (client Fast Open is on by
// default), a closed port doesn't, and the canary refuses the start when its listener is reached (#1521).
func TestProbeTriesTFO(t *testing.T) {
	if !clientTFOOn() {
		t.Skip("client TCP Fast Open is off here (net.ipv4.tcp_fastopen)")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if !tfoConnects(ln.Addr().String(), time.Second) {
		t.Error("a Fast Open send to a listener read as not connecting")
	}
	if tfoConnects("127.0.0.1:1", time.Second) {
		t.Error("a closed port read as reachable")
	}
	c, err := OpenTFOCanary()
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Check(time.Second); err == nil || !strings.Contains(err.Error(), "TCP Fast Open send reaches a loopback listener") {
		t.Errorf("the canary, unconfined: %v", err)
	}
}

// Pinning (#1637): a signal during the fail-closed checks' poll (EINTR) is tried again for the time left, not
// read as "not connected"; one that keeps coming still ends at the timeout.
func TestConnectedWithinRetriesEINTR(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	dial := func() int {
		fam, sa, _ := sockaddrFor(ln.Addr().String())
		fd, err := unix.Socket(fam, unix.SOCK_STREAM|unix.SOCK_NONBLOCK|unix.SOCK_CLOEXEC, 0)
		if err != nil {
			t.Fatal(err)
		}
		if err := unix.Connect(fd, sa); err != nil && err != unix.EINPROGRESS {
			t.Fatal(err)
		}
		return fd
	}
	defer func(f func([]unix.PollFd, int) (int, error)) { pollFn = f }(pollFn)
	interrupts := 0
	pollFn = func(p []unix.PollFd, ms int) (int, error) {
		if interrupts < 2 {
			interrupts++
			return 0, unix.EINTR
		}
		return unix.Poll(p, ms)
	}
	fd := dial()
	if !connectedWithin(fd, time.Second) {
		t.Error("a connect interrupted twice read as not connected")
	}
	unix.Close(fd)
	pollFn = func([]unix.PollFd, int) (int, error) { time.Sleep(10 * time.Millisecond); return 0, unix.EINTR }
	fd = dial()
	start := time.Now()
	if connectedWithin(fd, 200*time.Millisecond) {
		t.Error("an endless EINTR read as connected")
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("an endless EINTR took %v", time.Since(start))
	}
	unix.Close(fd)
}

// clientTFOOn reports whether client TCP Fast Open is on here (net.ipv4.tcp_fastopen bit 1, the kernel's default).
// Off, as on boxes, the kernel refuses a Fast Open send itself, so a case that expects the refusal tests the kernel,
// not the seccomp rule (#1637).
func clientTFOOn() bool {
	b, err := os.ReadFile("/proc/sys/net/ipv4/tcp_fastopen")
	if err != nil {
		return false
	}
	v, err := strconv.Atoi(strings.TrimSpace(string(b)))
	return err == nil && v&1 != 0
}
