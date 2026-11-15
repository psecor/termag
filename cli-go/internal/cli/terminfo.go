package cli

import (
	"encoding/base64"
	"regexp"
	"strings"
	"time"
)

// connect/terminfo.ts: a terminal's TERM has to name a terminfo entry the box has, so termag
// copies the local entry to the box (`infocmp -x` here, `tic -x` there), on the session's own
// command line, and falls back to xterm-256color when it has nothing to copy.

const fallbackTerm = "xterm-256color"

var safeTermRE = regexp.MustCompile(`^[A-Za-z0-9._+-]+$`)

// In ncurses-base, so on every Ubuntu box: no check.
var boxTerms = map[string]bool{
	"xterm": true, "xterm-256color": true, "xterm-color": true, "screen": true, "screen-256color": true, "tmux": true, "tmux-256color": true,
	"vt100": true, "vt102": true, "vt220": true, "linux": true, "dumb": true, "ansi": true, "rxvt": true, "rxvt-unicode": true, "rxvt-unicode-256color": true,
}

type termPlan struct {
	Kind   string // keep, install, fallback
	Term   string
	Source string
	Reason string
}

func planTerm(env map[string]string) termPlan {
	term := env["TERM"]
	if term == "" || boxTerms[term] {
		return termPlan{Kind: "keep"}
	}
	if !safeTermRE.MatchString(term) {
		return termPlan{Kind: "fallback", Term: term, Reason: "its name has characters termag does not pass to a box"}
	}
	infocmp := findTool("infocmp", env, false)
	if infocmp == "" {
		return termPlan{Kind: "fallback", Term: term, Reason: "there is no infocmp here to copy its terminfo entry to the box"}
	}
	r := captureCmd(infocmp, []string{"-x", term}, env, 10*time.Second)
	if r.Code != 0 || jsTrim(r.Stdout) == "" {
		return termPlan{Kind: "fallback", Term: term, Reason: "this machine has no terminfo entry for it to copy to the box"}
	}
	return termPlan{Kind: "install", Term: term, Source: r.Stdout}
}

// sshSessionConfig is what `ssh -G` says about a session with no command.
func sshSessionConfig(sshPath string, args []string, env map[string]string) (remoteCommand, noTTY bool) {
	r := captureCmd(sshPath, append([]string{"-G"}, args...), env, 10*time.Second)
	var lines []string
	for _, l := range strings.Split(r.Stdout, "\n") {
		lines = append(lines, strings.ToLower(jsTrim(l)))
	}
	value := func(key string) (string, bool) {
		for _, l := range lines {
			if strings.HasPrefix(l, key+" ") {
				return jsTrim(l[len(key)+1:]), true
			}
		}
		return "", false
	}
	remote, hasRemote := value("remotecommand")
	tty, _ := value("requesttty")
	return hasRemote && remote != "none", tty == "no" || tty == "false"
}

func fallbackNotice(p termPlan) string {
	return "termag: TERM=" + p.Term + " may be unknown on the box and " + p.Reason + "; using TERM=" + fallbackTerm + " for this session"
}

// withTerminfo is command, preceded by the check and the install.
func withTerminfo(term, source, command string) string {
	has := "infocmp " + term + " >/dev/null 2>&1"
	entry := base64.StdEncoding.EncodeToString([]byte(source))
	notice := shQuote("termag: could not install the terminfo entry for " + term + " on the box; using TERM=" + fallbackTerm)
	return "if ! " + has + "; then printf %s " + entry + " | base64 -d | tic -x -o \"$HOME/.terminfo\" - >/dev/null 2>&1; " +
		has + " || { echo " + notice + " >&2; TERM=" + fallbackTerm + "; export TERM; }; fi; " + command
}
