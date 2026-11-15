// termag-preview: the confining launcher behind `termag preview run`, and the
// sync and cleanup helpers it runs as other modes of the same binary.
//
// The agent spawns this with only stdin, stdout and stderr
// (agent/preview-runs.js); a user's shell never runs it.
//
//	termag-preview launch --home H --checkout C --run R [--cgroup DIR]
//	                      [--checkout-grant node-modules|none] [--allow-tcp PORT,...]
//	                      --env K=V ... -- COMMAND ARGS...
//	termag-preview sync   --home H --checkout C --run R [--watch]
//	termag-preview clean  --home H --checkout C --run R
//	termag-preview peercred      (fd 3 is a connected Unix socket; prints pid uid gid)
//	termag-preview abi
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

func init() {
	// Landlock restricts the calling thread only (no TSYNC on 6.8), so every
	// step from restrict_self to execve has to happen on one thread.
	runtime.LockOSThread()
}

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "launch":
		err = cmdLaunch(os.Args[2:])
	case "sync":
		err = cmdSync(os.Args[2:])
	case "clean":
		err = cmdClean(os.Args[2:])
	case "peercred":
		err = cmdPeercred()
	case "abi":
		fmt.Println(LandlockABI())
	case "features":
		// What this launcher enforces, for the agent to require (agent/preview-runs.js, launcherUsable).
		fmt.Println(strings.Join(Features, " "))
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "termag-preview:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: termag-preview launch|sync|clean|peercred|abi ...")
	os.Exit(2)
}

type common struct {
	fs     *flag.FlagSet
	layout Layout
}

func parseCommon(name string, args []string, extra func(*flag.FlagSet)) (*common, []string, error) {
	c := &common{fs: flag.NewFlagSet(name, flag.ContinueOnError)}
	c.fs.StringVar(&c.layout.Home, "home", "", "the user's home")
	c.fs.StringVar(&c.layout.Checkout, "checkout", "", "the workstream checkout (read-only)")
	c.fs.StringVar(&c.layout.Run, "run", "", "the run directory (writable)")
	if extra != nil {
		extra(c.fs)
	}
	if err := c.fs.Parse(args); err != nil {
		return nil, nil, err
	}
	if err := CheckLayout(c.layout); err != nil {
		return nil, nil, err
	}
	return c, c.fs.Args(), nil
}

// confine closes inherited descriptors, sets no_new_privs and applies both
// layers to the calling thread (and seccomp to every thread).
// tcp is the app's allowed TCP connect ports (net.go); nil for the helpers,
// whose rulesets don't handle TCP.
func confine(grants []Grant, l Layout, tcp []int, log func(string)) error {
	// An inherited descriptor to the agent's WebSocket, its local socket or a
	// tunnel would be a way out without a single socket() call. Mark every
	// descriptor above stderr close-on-exec rather than closing it: a plain
	// close_range(3, ~0U, 0) here also closes the Go runtime's epoll
	// descriptor, and the next non-blocking connect (the IMDS probe) kills
	// the runtime ("netpoll failed"). None of them survives the execve.
	if err := unix.CloseRange(3, ^uint(0), unix.CLOSE_RANGE_CLOEXEC); err != nil {
		return fmt.Errorf("close_range: %w", err)
	}
	rs, err := OpenRuleset(grants, l.Home)
	if err != nil {
		return err
	}
	defer rs.Close()
	if tcp != nil {
		rs.HandleTCP, rs.TCPConnect = true, tcp
	}
	if log != nil {
		log(rs.Describe())
	}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return fmt.Errorf("no_new_privs: %w", err)
	}
	if err := rs.Apply(); err != nil {
		return err
	}
	return ApplySeccomp()
}

func cmdLaunch(args []string) error {
	var envs multi
	var cgroup, checkoutGrant, allowTCP string
	c, rest, err := parseCommon("launch", args, func(fs *flag.FlagSet) {
		fs.Var(&envs, "env", "KEY=VALUE for the app (allowlisted names only)")
		fs.StringVar(&cgroup, "cgroup", "", "cgroup v2 directory to join before confining (the run's, for cgroup.kill)")
		fs.StringVar(&checkoutGrant, "checkout-grant", "node-modules", "what of the checkout the app reads: node-modules or none")
		fs.StringVar(&allowTCP, "allow-tcp", "", "ports the app may connect to besides 443, comma-separated (termag preview run --allow); never 80")
	})
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New("launch: no command")
	}
	cg, err := ParseCheckoutGrant(checkoutGrant)
	if err != nil {
		return err
	}
	declared, err := ParseAllow(allowTCP)
	if err != nil {
		return err
	}
	tcp := AllowedTCPPorts(declared)
	env, err := BuildEnv(envs)
	if err != nil {
		return err
	}
	work := filepath.Join(c.layout.Run, "work")
	if cgroup != "" {
		if err := JoinCgroup(cgroup); err != nil {
			return err
		}
	}
	logf := func(s string) { fmt.Fprint(os.Stderr, "termag-preview: ", s) }
	// Yama's ptrace_scope first: the pidfd_getfd and ptrace refusals rest on it.
	if err := CheckPtraceScope(); err != nil {
		return err
	}
	// Opened unconfined: after confinement, a TCP Fast Open send to it must not connect.
	canary, err := OpenTFOCanary()
	if err != nil {
		return err
	}
	if err := confine(AppGrants(c.layout, cg), c.layout, tcp, logf); err != nil {
		canary.ln.Close()
		return err
	}
	// Fail closed: check the port rule did refuse IMDS (TCP, MPTCP and TCP Fast Open), and that a Fast Open send
	// reaches nothing, before the app runs.
	if err := ProbeIMDS(time.Second); err != nil {
		canary.ln.Close()
		return err
	}
	if err := canary.Check(time.Second); err != nil {
		return err
	}
	// The line the agent looks for before it names the app's refused connects
	// (agent/preview-runs.js, diagnose): in this sandbox a TCP connect gets
	// EACCES only from the port rule.
	fmt.Fprintln(os.Stderr, TCPNotice(tcp))
	// In the work copy first, so a relative PATH entry resolves there (Devin, #1519).
	if err := os.Chdir(work); err != nil {
		return err
	}
	argv0, err := lookPath(rest[0], env)
	if err != nil {
		return err
	}
	return unix.Exec(argv0, rest, env)
}

// lookPath resolves the command on the app's PATH, not the launcher's.
func lookPath(name string, env []string) (string, error) {
	if strings.Contains(name, "/") {
		return name, nil
	}
	for _, kv := range env {
		if p, ok := strings.CutPrefix(kv, "PATH="); ok {
			for _, dir := range filepath.SplitList(p) {
				f := filepath.Join(dir, name)
				if unix.Access(f, unix.X_OK) == nil {
					return f, nil
				}
			}
		}
	}
	return "", fmt.Errorf("%s: not found on the app's PATH", name)
}

func cmdSync(args []string) error {
	var watch, copyNM bool
	c, _, err := parseCommon("sync", args, func(fs *flag.FlagSet) {
		fs.BoolVar(&watch, "watch", false, "keep the copy current until killed")
		fs.BoolVar(&copyNM, "copy-node-modules", false, "copy node_modules instead of the symlink overlay (Turbopack)")
	})
	if err != nil {
		return err
	}
	work := filepath.Join(c.layout.Run, "work")
	gitDirs, err := LinkedGitDirs(c.layout.Checkout, c.layout.Home)
	if err != nil {
		return err
	}
	if err := confine(SyncGrants(c.layout, work, gitDirs), c.layout, nil, nil); err != nil {
		return err
	}
	s, err := NewSyncer(c.layout.Checkout, work)
	if err != nil {
		return err
	}
	defer s.Close()
	// The agent waits for this line before it starts the launcher. With
	// --watch, only once the checkout is watched: a copy that would never get
	// the owner's edits doesn't start (Bugbot, #1519). And the watches come
	// first, then the copy, so nothing edited meanwhile is missed.
	ready := func() { fmt.Fprintf(os.Stderr, "termag-preview sync: ready, copied %d paths\n", len(s.synced)) }
	initial := func() error { return s.Initial(copyNM) }
	if !watch {
		if err := initial(); err != nil {
			return err
		}
		ready()
		return nil
	}
	return s.Watch(os.Stderr, !copyNM, initial, ready)
}

func cmdClean(args []string) error {
	c, _, err := parseCommon("clean", args, nil)
	if err != nil {
		return err
	}
	if err := confine(CleanGrants(c.layout), c.layout, nil, nil); err != nil {
		return err
	}
	// Empty the run directory without following anything; the agent removes
	// the (then empty) directory itself.
	return RemoveContents(c.layout.Run)
}

// cmdPeercred reads SO_PEERCRED from fd 3. Node's net module has no
// SO_PEERCRED, so the agent passes the accepted socket here.
func cmdPeercred() error {
	u, err := unix.GetsockoptUcred(3, unix.SOL_SOCKET, unix.SO_PEERCRED)
	if err != nil {
		return err
	}
	fmt.Printf("%d %d %d\n", u.Pid, u.Uid, u.Gid)
	return nil
}

// git runs git as the sync helper's child, under the helper's ruleset, with
// no user or system config and no fsmonitor.
func git(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("/usr/bin/git", append([]string{"-c", "core.fsmonitor=false", "-C", dir}, args...)...)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=/nonexistent", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "LANG=C"}
	cmd.Stderr = os.Stderr
	return cmd.Output()
}
