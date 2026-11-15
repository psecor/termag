package cli

import (
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Handler runs one command and returns its exit code. An error is reported as main.ts does.
type Handler func(c *Ctx, a *ParsedArgs) (int, error)

// handlers is the Go dispatch table: a command in COMMANDS that is not here runs in the Node CLI.
// A command file adds its own in an init(), so ports don't touch one shared list.
var handlers = map[string]Handler{
	"login":        cmdLogin,
	"logout":       cmdLogout,
	"whoami":       cmdWhoami,
	"box list":     cmdBoxList,
	"project list": cmdProjectList,
	// TODO(cli-go phase 2): tui (launcher only), update (stays git pull + install.sh), doctor,
	// the box lifecycle (box create/start/stop/keep/set/rename/resize/rm), project create/rename/archive,
	// handoff, automation *, environment *, bug list/show/triage, space share/unshare/
	// create/members/boxes/slack, space memory add/edit/rm/log, preview *.
	// events, forward, ssh, ssh-proxy, ssh-config and attach register themselves (events.go, forward.go, connect.go).
}

// register adds a handler. Command files' init() can run before spec.go's (files init in name
// order), so the check that name is in spec_gen.go is a test (TestHandlersAreCommands), not here.
func register(name string, h Handler) { handlers[name] = h }

// Ported says whether the Go binary runs this command itself.
func Ported(command string) bool { _, ok := handlers[command]; return ok }

func reportError(c *Ctx, err *CliError, asJSON bool) {
	if asJSON {
		c.Err(CompactJSON(newObject().Set("error", newObject().Set("code", err.Code).Set("message", err.Message))))
	} else {
		c.Err("termag: " + err.Message)
	}
}

func asCliError(err error) *CliError {
	var ce *CliError
	if errors.As(err, &ce) {
		return ce
	}
	return newErr("failed", err.Error())
}

// Run is main.ts's run: parse, then help/version, then the command, then its usage report.
func Run(argv []string, c *Ctx) (code int) {
	asJSON := false
	for _, a := range argv {
		if a == "--json" {
			asJSON = true
		}
	}
	args, err := ParseCommandLine(argv)
	if err != nil {
		e := asCliError(err)
		reportError(c, e, asJSON)
		return e.ExitCode()
	}
	if args.Version {
		if args.JSON {
			c.Out(CompactJSON(newObject().Set("version", Version)))
		} else {
			c.Out("termag " + Version)
		}
		return ExitOK
	}
	if args.Help || args.Command == "" {
		c.Out(HelpText(args.Command))
		if args.Help {
			return ExitOK
		}
		return ExitUsage
	}
	h, ok := handlers[args.Command]
	if !ok {
		return fallback(c, argv, args.JSON)
	}
	started := c.now()
	atStart := reportedAtStart[args.Command]
	if atStart {
		r := newUsageReport(c, args.Command, nil, 0)
		if awaitedAtStart[args.Command] {
			reportUsage(c, args, r)
		} else {
			go reportUsage(c, args, r)
		}
	}
	code, err = runHandler(h, c, args)
	if errors.Is(err, errFallback) {
		return fallback(c, argv, args.JSON)
	}
	if err != nil {
		e := asCliError(err)
		reportError(c, e, args.JSON)
		code = e.ExitCode()
	}
	if !atStart {
		reportUsage(c, args, newUsageReport(c, args.Command, &code, time.Since(started)))
	}
	return code
}

// runHandler turns a panic into exit 1, as an uncaught error is in Node.
func runHandler(h Handler, c *Ctx, a *ParsedArgs) (code int, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = newErr("failed", fmt.Sprint(r))
		}
	}()
	return h(c, a)
}

// fallback execs the Node CLI; when that cannot start, the error is reported like any other, as
// {"error":{…}} on stderr under --json.
func fallback(c *Ctx, argv []string, asJSON bool) int {
	if FallbackHook != nil {
		return FallbackHook(argv)
	}
	e := asCliError(execNode(c, argv))
	reportError(c, e, asJSON)
	return e.ExitCode()
}

// FallbackHook replaces the exec into Node (tests).
var FallbackHook func(argv []string) int

// Main is the binary's entry point.
func Main() int {
	if len(os.Args) > 1 && os.Args[1] == usagePostCommand {
		return RunUsagePost()
	}
	// A reader that goes away (`termag … | head -1`) makes writes fail with EPIPE, which LineWriter
	// absorbs, instead of the Go runtime killing the process with SIGPIPE on fd 1 or 2. Notify, not
	// Ignore: an ignored signal stays ignored in the children this process execs.
	signal.Notify(make(chan os.Signal, 1), syscall.SIGPIPE)
	return Run(os.Args[1:], DefaultCtx())
}
