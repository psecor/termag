package cli

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// The strangler: a command the Go binary does not own yet runs in the Node CLI, with the same
// argv, environment and terminal, by exec (the process becomes Node; its exit code is Node's).

// errFallback, returned by a handler before it has done anything, hands the run to Node
// (`ask --new-box`, the parts of `space memory` that are not ported yet).
var errFallback = errors.New("fallback to the Node CLI")

// cliCheckout is the termag checkout the Node CLI runs from: TERMAG_CLI_CHECKOUT (the launcher
// exports it), else the checkout this binary sits in (<checkout>/cli-go/dist/termag).
func cliCheckout(env map[string]string) string {
	if d := env["TERMAG_CLI_CHECKOUT"]; d != "" {
		return d
	}
	if self, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(self); err == nil {
			self = resolved
		}
		dir := filepath.Dir(self)
		for i := 0; i < 4; i++ {
			if _, err := os.Stat(filepath.Join(dir, "cli", "bin", "termag.js")); err == nil {
				return dir
			}
			dir = filepath.Dir(dir)
		}
	}
	return ""
}

// nodeBinary: TERMAG_CLI_NODE (a launcher that pins its Node exports it), else node on PATH.
func nodeBinary(env map[string]string) (string, error) {
	if n := env["TERMAG_CLI_NODE"]; n != "" {
		if st, err := os.Stat(n); err == nil && !st.IsDir() {
			return n, nil
		}
	}
	p, err := exec.LookPath("node")
	if err != nil {
		return "", err
	}
	return p, nil
}

func nodeCommand(env map[string]string) (node, script string, err error) {
	checkout := cliCheckout(env)
	if checkout == "" {
		return "", "", newErr("failed", "this command runs in the Node CLI, and no termag checkout was found; set TERMAG_CLI_CHECKOUT")
	}
	script = filepath.Join(checkout, "cli", "bin", "termag.js")
	if _, err := os.Stat(script); err != nil {
		return "", "", newErr("failed", fmt.Sprintf("this command runs in the Node CLI, and %s is missing; run `make install-cli` in the termag checkout", script))
	}
	node, err = nodeBinary(env)
	if err != nil {
		return "", "", newErr("failed", "this command runs in the Node CLI, and no `node` was found; install Node.js 20 or newer, or set TERMAG_CLI_NODE")
	}
	return node, script, nil
}

// execNode replaces this process with the Node CLI. It returns only on failure.
func execNode(c *Ctx, argv []string) error {
	node, script, err := nodeCommand(c.Env)
	if err != nil {
		return err
	}
	env := os.Environ()
	if c.Env["TERMAG_CLI_CHECKOUT"] == "" {
		env = append(env, "TERMAG_CLI_CHECKOUT="+filepath.Dir(filepath.Dir(filepath.Dir(script))))
	}
	if err := syscall.Exec(node, append([]string{node, script}, argv...), env); err != nil {
		return newErr("failed", "could not run the Node CLI: "+err.Error())
	}
	return nil
}

// runNodeChild runs the Node CLI as a child on this terminal; with capture, its stdout is returned.
func runNodeChild(args []string, capture bool) (int, string, error) {
	env := environMap()
	node, script, err := nodeCommand(env)
	if err != nil {
		return 0, "", err
	}
	cmd := exec.Command(node, append([]string{script}, args...)...)
	cmd.Stdin, cmd.Stderr = os.Stdin, os.Stderr
	var out bytes.Buffer
	if capture {
		cmd.Stdout = &out
	} else {
		cmd.Stdout = os.Stdout
	}
	err = cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), out.String(), nil
	}
	if err != nil {
		return 0, "", err
	}
	return 0, strings.TrimRight(out.String(), "\n"), nil
}
