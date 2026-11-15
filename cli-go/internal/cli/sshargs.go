package cli

import (
	"fmt"
	"regexp"
	"strings"
)

// connect/sshArgs.ts: the argv termag gives OpenSSH.

var shPlainRE = regexp.MustCompile(`^[A-Za-z0-9_@%+=:,./-]+$`)

// shQuote is POSIX shell quoting; plain words stay readable.
func shQuote(word string) string {
	if word != "" && shPlainRE.MatchString(word) {
		return word
	}
	return "'" + strings.ReplaceAll(word, "'", `'\''`) + "'"
}

// tmuxAttachCommand attaches to a project's tmux session, then makes the window follow the
// client used last (older sessions have `window-size largest`).
func tmuxAttachCommand(session string) string {
	return "tmux attach-session -t " + shQuote(session) + " ';' set-option -w window-size latest"
}

// remoteCommandLine: one word is a shell command line, as with ssh; several are words passed intact.
func remoteCommandLine(words []string) (string, bool) {
	switch len(words) {
	case 0:
		return "", false
	case 1:
		return words[0], true
	}
	q := make([]string, len(words))
	for i, w := range words {
		q[i] = shQuote(w)
	}
	return strings.Join(q, " "), true
}

// ssh(1) single-letter options that take a value.
const sshFlagsWithValue = "BbcDEeFIiJLlmOoPpQRSWw"

var sshOptionRE = regexp.MustCompile(`^-[A-Za-z0-9]`)

type scannedOptions struct {
	flags map[byte]bool
	stray []string
}

// scanSshOptions reads the ssh options a user passed through, without interpreting them.
func scanSshOptions(tokens []string) scannedOptions {
	s := scannedOptions{flags: map[byte]bool{}}
	for i := 0; i < len(tokens); i++ {
		t := tokens[i]
		if !sshOptionRE.MatchString(t) {
			s.stray = append(s.stray, t)
			continue
		}
		for j := 1; j < len(t); j++ {
			s.flags[t[j]] = true
			if strings.IndexByte(sshFlagsWithValue, t[j]) >= 0 {
				if j == len(t)-1 {
					i++
				}
				break
			}
		}
	}
	return s
}

func splitAtDoubleDash(tokens []string) (options, command []string) {
	for i, t := range tokens {
		if t == "--" {
			return tokens[:i], tokens[i+1:]
		}
	}
	return tokens, nil
}

type ssmRoute struct {
	AwsPath, InstanceID, Region, Profile, Document string
}

// ssmProxyCommand is USAGE.md's laptop ProxyCommand with the box filled in; ssh expands % tokens
// before the shell sees the line, so literal ones are doubled.
func ssmProxyCommand(r ssmRoute) string {
	lit := func(w string) string { return strings.ReplaceAll(shQuote(w), "%", "%%") }
	return strings.Join([]string{
		lit(r.AwsPath), "ssm", "start-session",
		"--target", lit(r.InstanceID),
		"--document-name", lit(r.Document),
		"--parameters", "portNumber=%p",
		"--region", lit(r.Region),
		"--profile", lit(r.Profile),
	}, " ")
}

type sshPlan struct {
	Route       ssmRoute
	Alias       string
	User        string
	UserOptions []string
	Remote      string
	HasRemote   bool
	TTY         bool
	Batch       bool
}

// buildSshArgv: the user's options first (ssh keeps the first value it sees for each setting).
// The host key is filed under the instance id, so a box re-created under the same name is a new host.
func buildSshArgv(p sshPlan) []string {
	argv := append([]string{}, p.UserOptions...)
	argv = append(argv,
		"-o", "ProxyCommand="+ssmProxyCommand(p.Route),
		"-o", "HostKeyAlias="+p.Route.InstanceID,
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "ServerAliveInterval=30",
		"-o", "User="+p.User,
	)
	if p.Batch {
		argv = append(argv, "-o", "BatchMode=yes")
	}
	if p.TTY {
		argv = append(argv, "-t")
	}
	argv = append(argv, p.Alias)
	if p.HasRemote {
		argv = append(argv, p.Remote)
	}
	return argv
}

func inDirectory(directory, command string) string {
	return "cd " + shQuote(directory) + " && " + command
}

const loginShell = `exec "${SHELL:-/bin/sh}" -l`

func assertNoStrayWords(s scannedOptions) error {
	if len(s.stray) > 0 {
		return usageError(fmt.Sprintf("`%s` is not an ssh option; put the remote command after `--`", s.stray[0]))
	}
	return nil
}
