package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// connect/sshConfig.ts: the `Host termag-*` block in ~/.ssh/config, and the managed-block writer
// the AWS profile shares.

const (
	sshBeginMarker = "# >>> termag ssh-config >>>"
	sshEndMarker   = "# <<< termag ssh-config <<<"
)

func sshConfigPath(home string) string { return filepath.Join(home, ".ssh", "config") }

// proxyCommandFor: `<termag> [--host <url>] ssh-proxy [--wake] %h %p`.
func proxyCommandFor(termag []string, host string, wake bool) string {
	var words []string
	for _, w := range termag {
		words = append(words, strings.ReplaceAll(shQuote(w), "%", "%%"))
	}
	if host != "" {
		words = append(words, "--host", strings.ReplaceAll(shQuote(host), "%", "%%"))
	}
	words = append(words, "ssh-proxy")
	if wake {
		words = append(words, "--wake")
	}
	return strings.Join(append(words, "%h", "%p"), " ")
}

var (
	sshSafeName = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	sshSafeUser = regexp.MustCompile(`^[a-z_][a-z0-9_.-]*$`)
)

// sshBoxHost is sshConfig.ts's BoxHost: `Host termag-<box>`, whose HostName is the box's instance
// id, so the ProxyCommand's %h names the box by id (OpenSSH lowercases %h, and a lowercased name
// can't tell Devbox from devbox; an id has no case to lose). Nil HostName: a box with no usable
// instance id, which ssh-proxy finds by name. Nil User: the wildcard's.
type sshBoxHost struct {
	Alias    string  `json:"alias"`
	HostName *string `json:"hostName"`
	User     *string `json:"user"`
}

type sshSessionHost struct{ Alias, HostName, User, Session string }

type sshHostsResult struct {
	BoxHosts     []sshBoxHost
	SessionHosts []sshSessionHost
	Skipped      []string
}

func localeCompare(a, b string) int {
	switch {
	case localeLess(a, b):
		return -1
	case localeLess(b, a):
		return 1
	}
	return 0
}

// sshHosts: the per-box and per-project hosts for the block.
func sshHosts(user string, boxes []ConnectBox, projects []ConnectProject) sshHostsResult {
	var named []*ConnectBox
	for i := range boxes {
		if sshSafeName.MatchString(boxes[i].Name) {
			named = append(named, &boxes[i])
		}
	}
	boxUser := func(b *ConnectBox) string {
		if b.HostUnixUser != nil && *b.HostUnixUser != "" && sshSafeUser.MatchString(*b.HostUnixUser) {
			return *b.HostUnixUser
		}
		return user
	}
	hostName := func(b *ConnectBox) *string {
		if b.EC2InstanceID != nil && instanceIDRE.MatchString(*b.EC2InstanceID) {
			return b.EC2InstanceID
		}
		return nil
	}
	var r sshHostsResult
	for _, b := range named {
		h := sshBoxHost{Alias: aliasFor(b), HostName: hostName(b)}
		if u := boxUser(b); u != user {
			h.User = &u
		}
		if h.HostName != nil || h.User != nil {
			r.BoxHosts = append(r.BoxHosts, h)
		}
	}
	sort.SliceStable(r.BoxHosts, func(i, j int) bool { return localeLess(r.BoxHosts[i].Alias, r.BoxHosts[j].Alias) })
	byID := map[string]*ConnectBox{}
	for _, b := range named {
		byID[b.ID] = b // new Map(entries): a later entry for the same id wins
	}
	type onBox struct {
		p           *ConnectProject
		box         *ConnectBox
		agent, ctrl string
	}
	var on []onBox
	for i := range projects {
		p := &projects[i]
		if b, ok := byID[p.Box.ID]; ok && p.Sessions != nil {
			on = append(on, onBox{p, b, p.Sessions.Agent, p.Sessions.Ctrl})
		}
	}
	sort.SliceStable(on, func(i, j int) bool {
		if c := localeCompare(on[i].box.Name, on[j].box.Name); c != 0 {
			return c < 0
		}
		return localeCompare(on[i].p.Name, on[j].p.Name) < 0
	})
	for _, o := range on {
		if !sshSafeName.MatchString(o.p.Name) || !sshSafeName.MatchString(o.agent) || !sshSafeName.MatchString(o.ctrl) {
			r.Skipped = append(r.Skipped, o.box.Name+"/"+o.p.Name)
			continue
		}
		alias := aliasFor(o.box)
		at := alias
		if id := hostName(o.box); id != nil {
			at = *id
		}
		u := boxUser(o.box)
		r.SessionHosts = append(r.SessionHosts,
			sshSessionHost{alias + "." + o.p.Name, at, u, o.agent},
			sshSessionHost{alias + "." + o.p.Name + ".ctrl", at, u, o.ctrl})
	}
	return r
}

// renderSshBlock is the one `Host termag-*` entry, which goes at the top of the file.
// boxHosts and sessionHosts come before the wildcard, since ssh takes the first value it finds;
// their HostName is the box's instance id (its alias when it has none), so the wildcard's
// ProxyCommand (%h) reaches that box.
func renderSshBlock(proxyCommand, user string, boxHosts []sshBoxHost, sessionHosts []sshSessionHost) string {
	lines := []string{
		sshBeginMarker,
		"# Managed by `termag ssh-config --install`, which replaces everything between these markers.",
		"# `ssh termag-<box>` reaches that box over SSM (TermagSSH), with the same checks as `termag ssh`.",
		"# `ssh termag-<box>.<project>` attaches to the project's agent tmux session, and `.ctrl` to its ctrl shell.",
	}
	for _, h := range boxHosts {
		lines = append(lines, "Host "+h.Alias)
		if h.HostName != nil {
			lines = append(lines, "  HostName "+*h.HostName)
		}
		if h.User != nil {
			lines = append(lines, "  User "+*h.User)
		}
	}
	for _, h := range sessionHosts {
		lines = append(lines, "Host "+h.Alias, "  HostName "+h.HostName, "  User "+h.User, "  RequestTTY yes", "  RemoteCommand "+tmuxAttachCommand(h.Session))
	}
	lines = append(lines,
		"Host termag-*",
		"  User "+user,
		"  ProxyCommand "+proxyCommand,
		"  StrictHostKeyChecking accept-new",
		"  ServerAliveInterval 30",
		"Host *",
		sshEndMarker,
	)
	return strings.Join(lines, "\n")
}

// managedBlock is a file region termag owns: everything between two marker lines.
type managedBlock struct {
	Begin, End, File, Command string
	AtTop                     bool
}

var sshManaged = managedBlock{sshBeginMarker, sshEndMarker, "~/.ssh/config", "termag ssh-config --install", true}

var trailingNewlinesRE = regexp.MustCompile(`\n*$`)

// upsertBlock puts block in existing between the markers, touching nothing outside them.
func upsertBlock(existing, block string, m managedBlock) (string, string, error) {
	lines := strings.Split(existing, "\n")
	var begins, ends []int
	for i, l := range lines {
		switch jsTrim(l) {
		case m.Begin:
			begins = append(begins, i)
		case m.End:
			ends = append(ends, i)
		}
	}
	if len(begins) == 0 && len(ends) == 0 {
		if existing == "" {
			return block + "\n", "added", nil
		}
		if m.AtTop {
			return block + "\n\n" + existing, "added", nil
		}
		return trailingNewlinesRE.ReplaceAllString(existing, "") + "\n\n" + block + "\n", "added", nil
	}
	if len(begins) != 1 || len(ends) != 1 || ends[0] < begins[0] {
		return "", "", newErr("failed", fmt.Sprintf("The termag markers in %s are unmatched or repeated; remove the termag lines by hand and re-run `%s`", m.File, m.Command))
	}
	out := append(append(append([]string{}, lines[:begins[0]]...), block), lines[ends[0]+1:]...)
	content := strings.Join(out, "\n")
	if content == existing {
		return content, "unchanged", nil
	}
	return content, "updated", nil
}

// readIfExists is the file's text, or ok false when there is none.
func readIfExists(p string) (string, bool, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", false, nil
		}
		return "", false, err
	}
	return string(b), true, nil
}

// installResult is installBlock's answer, in Node's key order.
type installResult struct {
	Path   string  `json:"path"`
	Action string  `json:"action"`
	Backup *string `json:"backup"`
}

// rewriteConfig rewrites the config at path with edit: a symlinked config is edited where it
// really lives, the previous content kept in <config>.termag-backup, and the new file put in place
// in one rename with the old file's mode (0600 for a new one).
func rewriteConfig(p string, edit func(string) (string, string, error), unchanged string) (installResult, error) {
	target := p
	if real, err := filepath.EvalSymlinks(p); err == nil {
		target = real
	}
	existing, had, err := readIfExists(target)
	if err != nil {
		return installResult{}, err
	}
	content, action, err := edit(existing)
	if err != nil {
		return installResult{}, err
	}
	if action == unchanged {
		return installResult{Path: target, Action: action}, nil
	}
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return installResult{}, err
	}
	mode := os.FileMode(0o600)
	var backup *string
	if had {
		st, err := os.Stat(target)
		if err != nil {
			return installResult{}, err
		}
		mode = st.Mode().Perm()
		b := target + ".termag-backup"
		if err := sshcCopyFile(target, b); err != nil {
			return installResult{}, err
		}
		if err := os.Chmod(b, mode); err != nil {
			return installResult{}, err
		}
		backup = &b
	}
	tmp := filepath.Join(dir, fmt.Sprintf(".config.termag-%d-%d", os.Getpid(), time.Now().UnixMilli()))
	err = os.WriteFile(tmp, []byte(content), mode)
	if err == nil {
		err = os.Chmod(tmp, mode)
	}
	if err == nil {
		err = os.Rename(tmp, target)
	}
	if err != nil {
		os.Remove(tmp)
		return installResult{}, err
	}
	return installResult{Path: target, Action: action, Backup: backup}, nil
}

func sshcCopyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func installBlock(p, block string, m managedBlock) (installResult, error) {
	return rewriteConfig(p, func(existing string) (string, string, error) { return upsertBlock(existing, block, m) }, "unchanged")
}

// dropBlock drops the markers and everything between them, plus the blank line that set it off.
func dropBlock(existing string, m managedBlock) (string, string) {
	lines := strings.Split(existing, "\n")
	begin, end := -1, -1
	for i, l := range lines {
		if jsTrim(l) == m.Begin {
			begin = i
			break
		}
	}
	for i, l := range lines {
		if i > begin && jsTrim(l) == m.End {
			end = i
			break
		}
	}
	if begin < 0 || end < 0 {
		return existing, "absent"
	}
	from := begin
	if begin > 0 && jsTrim(lines[begin-1]) == "" {
		from = begin - 1
	}
	to := end + 1
	if from == 0 && end+1 < len(lines) && jsTrim(lines[end+1]) == "" {
		to = end + 2
	}
	return strings.Join(append(append([]string{}, lines[:from]...), lines[to:]...), "\n"), "removed"
}

func removeBlock(p string, m managedBlock) (installResult, error) {
	return rewriteConfig(p, func(existing string) (string, string, error) {
		c, a := dropBlock(existing, m)
		return c, a, nil
	}, "absent")
}
