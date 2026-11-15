package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// connect/commands.ts: `ssh`, `attach`, `ssh-config` and `ssh-proxy`. They exec the real OpenSSH
// and the aws CLI (Session Manager): users' keys, agents, ~/.ssh/config, -L, scp, rsync and
// editors' Remote-SSH all depend on that.

func init() {
	register("ssh", cmdSsh)
	register("attach", cmdAttach)
	register("ssh-config", cmdSshConfig)
	register("ssh-proxy", cmdSshProxy)
}

type resolvedTarget struct {
	api        *Api
	box        *ConnectBox
	project    *ConnectProject
	instanceID string
	region     string
	user       string
	whoami     *whoamiResponse
}

func (r *resolvedTarget) ownerUnixUser() (string, error) {
	if r.whoami == nil {
		w, err := getWhoami(r.api)
		if err != nil {
			return "", err
		}
		r.whoami = w
	}
	return r.whoami.User.UnixUsername, nil
}

// resolveTargetRef: a box (and project) to reach over SSM; the box must be a running EC2 box.
func resolveTargetRef(c *Ctx, s *Session, ref Ref) (*resolvedTarget, error) {
	api, box, err := resolveBox(c, s, ref.Box, ref.HasBox)
	if err != nil {
		return nil, err
	}
	instanceID, region, err := ssmTarget(box, awsSettings(c.Env).DefaultRegion)
	if err != nil {
		return nil, err
	}
	r := &resolvedTarget{api: api, box: box, instanceID: instanceID, region: region}
	if ref.HasProject {
		var res struct {
			Projects []ConnectProject `json:"projects"`
		}
		if err := api.Request(context.Background(), "GET", "/projects", nil, &res); err != nil {
			return nil, err
		}
		if r.project, err = pickProject(res.Projects, box, ref.Project); err != nil {
			return nil, err
		}
	}
	if box.HostUnixUser != nil && *box.HostUnixUser != "" {
		r.user = *box.HostUnixUser
	} else if r.user, err = r.ownerUnixUser(); err != nil {
		return nil, err
	}
	return r, nil
}

// directoryOf is relative to the home ssh lands in, for an orchestrator that predates `directory`.
func directoryOf(p *ConnectProject) string {
	if p.Directory != nil {
		return *p.Directory
	}
	return "termag/projects/" + p.Name
}

type connectOpts struct {
	userOptions []string
	remote      string
	hasRemote   bool
	tty         bool
	terminal    bool
}

func connectSsh(c *Ctx, r *resolvedTarget, o connectOpts) (int, error) {
	settings := awsSettings(c.Env)
	awsPath, err := preflight(c, settings, c.Interactive, inheritStdio())
	if err != nil {
		return 0, err
	}
	sshPath := findTool("ssh", c.Env, false)
	if sshPath == "" {
		return 0, newErr("failed", "ssh (OpenSSH) is not installed")
	}
	env := c.Env
	if o.terminal {
		plan := planTerm(c.Env)
		if plan.Kind == "install" && !o.hasRemote {
			remoteCmd, noTTY := sshSessionConfig(sshPath, append(append([]string{}, o.userOptions...), aliasFor(r.box)), c.Env)
			if noTTY {
				plan = termPlan{Kind: "keep"}
			} else if remoteCmd {
				plan = termPlan{Kind: "fallback", Term: plan.Term, Reason: "ssh's RemoteCommand leaves no command to install its terminfo entry before"}
			}
		}
		switch plan.Kind {
		case "install":
			cmd := loginShell
			if o.hasRemote {
				cmd = o.remote
			}
			o.remote, o.hasRemote, o.tty = withTerminfo(plan.Term, plan.Source, cmd), true, true
		case "fallback":
			c.Err(fallbackNotice(plan))
			env = map[string]string{}
			for k, v := range c.Env {
				env[k] = v
			}
			env["TERM"] = fallbackTerm
		}
	}
	argv := buildSshArgv(sshPlan{
		Route:       ssmRoute{AwsPath: awsPath, InstanceID: r.instanceID, Region: r.region, Profile: settings.Profile, Document: settings.Document},
		Alias:       aliasFor(r.box),
		User:        r.user,
		UserOptions: o.userOptions,
		Remote:      o.remote,
		HasRemote:   o.hasRemote,
		TTY:         o.tty,
		Batch:       !c.Interactive,
	})
	// ssh's own exit status is the result, as with running ssh directly.
	return runAttached(c, sshPath, argv, env, inheritStdio()), nil
}

func cmdSsh(c *Ctx, a *ParsedArgs) (int, error) {
	text := ""
	if len(a.Args) > 0 {
		text = a.Args[0]
	}
	ref, err := parseRef(text, false)
	if err != nil {
		return 0, err
	}
	options, command := splitAtDoubleDash(a.Passthrough)
	scanned := scanSshOptions(options)
	if err := assertNoStrayWords(scanned); err != nil {
		return 0, err
	}
	s, err := newSession(c, a)
	if err != nil {
		return 0, err
	}
	r, err := resolveTargetRef(c, s, ref)
	if err != nil {
		return 0, err
	}
	noCommand := scanned.flags['N']
	remote, hasRemote := "", false
	if !noCommand {
		remote, hasRemote = remoteCommandLine(command)
	}
	terminal := !hasRemote && !noCommand && c.Interactive && !scanned.flags['T']
	tty := false
	if r.project != nil && !noCommand {
		dir := directoryOf(r.project)
		if !hasRemote {
			remote, hasRemote = inDirectory(dir, loginShell), true
			tty = c.Interactive && !scanned.flags['T'] && !scanned.flags['t']
		} else {
			remote = inDirectory(dir, remote)
		}
	}
	if options == nil {
		options = []string{}
	}
	return connectSsh(c, r, connectOpts{userOptions: options, remote: remote, hasRemote: hasRemote, tty: tty, terminal: terminal})
}

func cmdAttach(c *Ctx, a *ParsedArgs) (int, error) {
	text := ""
	if len(a.Args) > 0 {
		text = a.Args[0]
	}
	ref, err := parseRef(text, false)
	if err != nil {
		return 0, err
	}
	if !ref.HasProject {
		return 0, usageError("`termag attach` needs a project: termag attach <box>/<project>")
	}
	if !c.Interactive {
		return 0, newErr("failed", "`termag attach` needs a terminal; from a script, use `termag ssh <box>/<project> -- <cmd>`")
	}
	s, err := newSession(c, a)
	if err != nil {
		return 0, err
	}
	r, err := resolveTargetRef(c, s, ref)
	if err != nil {
		return 0, err
	}
	role := "agent"
	if a.Bool("ctrl") {
		role = "ctrl"
	}
	name := ""
	if r.project.Sessions != nil {
		name = r.project.Sessions.Agent
		if role == "ctrl" {
			name = r.project.Sessions.Ctrl
		}
	} else {
		owner, err := r.ownerUnixUser()
		if err != nil {
			return 0, err
		}
		name = owner + "-" + r.project.Name + "-" + role
	}
	return connectSsh(c, r, connectOpts{userOptions: []string{}, remote: tmuxAttachCommand(name), hasRemote: true, tty: true, terminal: true})
}

// termagCommand is how ssh should start this CLI: the `termag` on PATH by absolute path (the
// launcher, which survives upgrades), else this very binary. Node's fallback is `node <script>`,
// which a Go install replaces with the binary, so a block written by Node's fallback is rewritten.
func termagCommand(c *Ctx) []string {
	if p := findTool("termag", c.Env, true); p != "" {
		return []string{p}
	}
	if self, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(self); err == nil {
			self = real
		}
		return []string{self}
	}
	return []string{"termag"}
}

func cmdSshConfig(c *Ctx, a *ParsedArgs) (int, error) {
	wake := a.Bool("wake")
	s, err := newSession(c, a)
	if err != nil {
		return 0, err
	}
	api, err := authedApi(c, s, 0)
	if err != nil {
		return 0, err
	}
	user := ""
	hasUser := false
	if l := LoadLogin(s.CredsPath, s.Target.Host); l != nil {
		if v, ok := l.obj.Get("unixUsername"); ok {
			if raw, ok := v.(json.RawMessage); ok && string(raw) != "null" {
				user, hasUser = l.str("unixUsername"), true
			}
		}
	}
	if !hasUser {
		w, err := getWhoami(api)
		if err != nil {
			return 0, err
		}
		user = w.User.UnixUsername
	}
	var boxes struct {
		Boxes []ConnectBox `json:"boxes"`
	}
	var projects struct {
		Projects []ConnectProject `json:"projects"`
	}
	if err := api.Request(context.Background(), "GET", "/boxes", nil, &boxes); err != nil {
		return 0, err
	}
	if err := api.Request(context.Background(), "GET", "/projects", nil, &projects); err != nil {
		return 0, err
	}
	hosts := sshHosts(user, boxes.Boxes, projects.Projects)
	for _, ref := range hosts.Skipped {
		c.Err(fmt.Sprintf("%s has no termag-<box>.<project> host: a name in it has characters ssh_config can't carry. `termag attach %s` reaches it.", ref, ref))
	}
	host := s.Target.Host
	if s.Target.Source == "default" {
		host = ""
	}
	block := renderSshBlock(proxyCommandFor(termagCommand(c), host, wake), user, hosts.BoxHosts, hosts.SessionHosts)
	path := sshConfigPath(c.Home)
	if !a.Bool("install") {
		if a.JSON {
			c.Out(JSONText(newObject().Set("path", path).Set("entry", block)))
		} else {
			c.Out(block)
		}
		return ExitOK, nil
	}
	res, err := installBlock(path, block, sshManaged)
	if err != nil {
		return 0, fsErr(err)
	}
	if a.JSON {
		c.Out(JSONText(res))
		return ExitOK, nil
	}
	verb := map[string]string{"added": "Added the termag entry to", "updated": "Updated the termag entry in", "unchanged": "The termag entry is already in"}[res.Action]
	b := ""
	if res.Backup != nil {
		b = " The previous file is " + *res.Backup + "."
	}
	c.Out(fmt.Sprintf("%s %s.%s", verb, res.Path, b))
	if res.Action != "unchanged" {
		if wake {
			c.Out("`ssh termag-<box>` now reaches each of your boxes and starts a parked one, and `ssh termag-<box>.<project>` (or `.ctrl`) attaches to a project. Re-run `termag ssh-config --install --wake` after adding a box or a project.")
		} else {
			c.Out("`ssh termag-<box>` now reaches each of your boxes, and `ssh termag-<box>.<project>` (or `.ctrl`) attaches to a project. Re-run this after adding a box or a project.")
		}
	}
	return ExitOK, nil
}

var jsDecimalRE = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

// jsNumberOf is Number(s) for the texts a flag carries (NaN for anything else).
func jsNumberOf(s string) float64 {
	t := jsTrim(s)
	switch {
	case t == "":
		return 0
	case strings.HasPrefix(t, "0x") || strings.HasPrefix(t, "0X"):
		if n, err := strconv.ParseUint(t[2:], 16, 64); err == nil {
			return float64(n)
		}
		return math.NaN()
	case t == "Infinity" || t == "+Infinity":
		return math.Inf(1)
	case t == "-Infinity":
		return math.Inf(-1)
	case !jsDecimalRE.MatchString(t):
		return math.NaN()
	}
	f, _ := strconv.ParseFloat(t, 64)
	return f
}

// timeoutSecondsOf is lifecycle.ts's timeoutSeconds.
func timeoutSecondsOf(a *ParsedArgs, fallback float64) (float64, error) {
	if !a.Has("timeout") {
		return fallback, nil
	}
	raw, isStr := a.Str("timeout")
	n := jsNumberOf(raw)
	if !isStr || math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 {
		return 0, usageError("--timeout takes a number of seconds")
	}
	return n, nil
}

// cmdSshProxy is the ssh-config entry's ProxyCommand. ssh runs it with the connection on stdin and
// stdout, so nothing but the SSM session ever writes to stdout. A person is present when stderr is
// a terminal; an editor's Remote-SSH gets a one-line reason instead of a prompt.
func cmdSshProxy(c *Ctx, a *ParsedArgs) (int, error) {
	if len(a.Args) < 2 || a.Args[0] == "" || a.Args[1] == "" {
		return 0, usageError("Usage: termag ssh-proxy [--wake [--timeout <seconds>]] termag-<box> <port>")
	}
	alias, port := a.Args[0], a.Args[1]
	if port != "22" {
		return 0, newErr("failed", "termag reaches boxes on port 22 only, not "+port)
	}
	wake := a.Bool("wake")
	if !wake && a.Has("timeout") {
		return 0, usageError("--timeout goes with --wake, which waits for the box")
	}
	timeoutS, err := timeoutSecondsOf(a, lcStartWaitS)
	if err != nil {
		return 0, err
	}
	s, err := newSession(c, a)
	if err != nil {
		return 0, err
	}
	api, box, err := resolveProxyBox(c, s, alias)
	if err != nil {
		return 0, err
	}
	settings := awsSettings(c.Env)
	action := "connect"
	if wake && box.Kind == "ec2" {
		action = wakeAction(box.State)
	}
	wakes := action != "connect" && action != "refuse"
	// A box that won't be woken is refused before AWS is touched.
	if !wakes {
		if _, _, err := ssmTarget(box, settings.DefaultRegion); err != nil {
			return 0, err
		}
	}
	awsPath, err := preflight(c, settings, c.StderrIsTTY, attachedStdio{Stdin: nil, Stdout: os.Stderr, Stderr: os.Stderr})
	if err != nil {
		return 0, err
	}
	target := box
	if wakes {
		c.Err(fmt.Sprintf("termag: %s is %s; bringing it up before connecting (--wake)", box.Name, box.State))
		up, err := lcStartAndWait(c, api, lcBox{ID: box.ID, Name: box.Name, State: box.State, AgentConnected: box.AgentConnected, Error: box.Error}, timeoutS, false)
		if err != nil {
			return 0, err
		}
		// The started box's SSM fields come from a fresh /boxes (Node's poll result carries them).
		var res struct {
			Boxes []ConnectBox `json:"boxes"`
		}
		if err := api.Request(context.Background(), "GET", "/boxes", nil, &res); err != nil {
			return 0, err
		}
		if target, err = pickBox(res.Boxes, up.ID, true); err != nil {
			return 0, err
		}
	}
	instanceID, region, err := ssmTarget(target, settings.DefaultRegion)
	if err != nil {
		return 0, err
	}
	return runAttached(c, awsPath, []string{
		"ssm", "start-session", "--target", instanceID, "--document-name", settings.Document,
		"--parameters", "portNumber=" + port, "--region", region, "--profile", settings.Profile,
	}, c.Env, inheritStdio()), nil
}
