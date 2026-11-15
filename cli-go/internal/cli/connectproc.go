package cli

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// connect/process.ts: finding and running ssh, aws, infocmp.

// Remote-SSH in a GUI editor runs the ProxyCommand with the GUI's PATH, which on macOS usually
// lacks Homebrew's bin directories.
var toolFallbackDirs = []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"}

func fallbackDirsFor(env map[string]string) []string {
	override, ok := env["TERMAG_TOOL_FALLBACK_DIRS"]
	if !ok {
		return toolFallbackDirs
	}
	var out []string
	for _, d := range strings.Split(override, string(os.PathListSeparator)) {
		if d != "" {
			out = append(out, d)
		}
	}
	return out
}

func isExecutableFile(p string) bool {
	if syscall.Access(p, 1) != nil { // X_OK
		return false
	}
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

// findTool is the absolute path of name on PATH, then (unless noFallback) in the usual install directories.
func findTool(name string, env map[string]string, noFallback bool) string {
	var dirs []string
	for _, d := range strings.Split(env["PATH"], string(os.PathListSeparator)) {
		if d != "" {
			dirs = append(dirs, d)
		}
	}
	if !noFallback {
		dirs = append(dirs, fallbackDirsFor(env)...)
	}
	for _, d := range dirs {
		if c := filepath.Join(d, name); isExecutableFile(c) {
			return c
		}
	}
	return ""
}

func envList(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}

type captured struct {
	Code   int
	Stdout string
	Stderr string
}

// captureCmd runs a command to completion, capturing its output; a timeout (SIGTERM) is 124, a
// spawn failure 127. Never an error for a non-zero exit.
func captureCmd(cmd string, args []string, env map[string]string, timeout time.Duration) captured {
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	c := exec.Command(cmd, args...)
	c.Env = envList(env)
	var out, errb bytes.Buffer
	c.Stdout, c.Stderr = &out, &errb
	if err := c.Start(); err != nil {
		return captured{Code: 127, Stderr: err.Error()}
	}
	timer := time.AfterFunc(timeout, func() { _ = c.Process.Signal(syscall.SIGTERM) })
	err := c.Wait()
	timer.Stop()
	r := captured{Stdout: out.String(), Stderr: errb.String()}
	var ee *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &ee):
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			if ws.Signal() == syscall.SIGTERM {
				r.Code = 124
			} else {
				r.Code = 1
			}
		} else {
			r.Code = ee.ExitCode()
		}
	default:
		r.Code = 127
		if r.Stderr == "" {
			r.Stderr = err.Error()
		}
	}
	return r
}

var signalExit = map[syscall.Signal]int{syscall.SIGHUP: 129, syscall.SIGINT: 130, syscall.SIGQUIT: 131, syscall.SIGTERM: 143}

// attachedStdio is where a child run on this terminal reads and writes; nil entries are /dev/null.
type attachedStdio struct {
	Stdin          *os.File
	Stdout, Stderr *os.File
}

func inheritStdio() attachedStdio { return attachedStdio{os.Stdin, os.Stdout, os.Stderr} }

// runAttached runs a command on this terminal and returns its exit status: 0-255, 129/130/131/143
// for a HUP/INT/QUIT/TERM, 1 for another signal, 127 when it can't start. While it runs, termag
// catches (and drops) Ctrl-C and friends and leaves them to the child, so the child decides when
// the session ends. Caught, not ignored: an ignored signal would stay ignored in the child.
func runAttached(c *Ctx, cmd string, args []string, env map[string]string, stdio attachedStdio) int {
	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGQUIT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(sigs)
	child := exec.Command(cmd, args...)
	child.Env = envList(env)
	if stdio.Stdin != nil {
		child.Stdin = stdio.Stdin
	}
	if stdio.Stdout != nil {
		child.Stdout = stdio.Stdout
	}
	if stdio.Stderr != nil {
		child.Stderr = stdio.Stderr
	}
	if err := child.Start(); err != nil {
		c.Err("termag: could not run " + cmd + ": " + spawnMessage(err))
		return 127
	}
	err := child.Wait()
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			if code, ok := signalExit[ws.Signal()]; ok {
				return code
			}
			return 1
		}
		return ee.ExitCode()
	}
	c.Err("termag: could not run " + cmd + ": " + err.Error())
	return 127
}

// spawnMessage is Node's `spawn <cmd> ENOENT` wording where it can be.
func spawnMessage(err error) string {
	var pe *os.PathError
	if errors.As(err, &pe) {
		switch {
		case errors.Is(pe.Err, syscall.ENOENT):
			return "spawn " + pe.Path + " ENOENT"
		case errors.Is(pe.Err, syscall.EACCES):
			return "spawn " + pe.Path + " EACCES"
		}
	}
	return err.Error()
}
