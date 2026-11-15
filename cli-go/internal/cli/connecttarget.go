package cli

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

// connect/target.ts: which box (and project) a connect command reaches. Shared by ssh, ssh-proxy,
// ssh-config, attach and forward.

// ConnectBox is the fields of GET /boxes that connecting needs; older orchestrators may omit some.
type ConnectBox struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Addressable    bool    `json:"addressable"`
	Kind           string  `json:"kind"`
	State          string  `json:"state"`
	Status         string  `json:"status"`
	AgentConnected bool    `json:"agentConnected"`
	Error          *string `json:"error"`
	EC2InstanceID  *string `json:"ec2InstanceId"`
	Region         *string `json:"region"`
	HostUnixUser   *string `json:"hostUnixUser"`
	CreatedFor     *string `json:"createdFor"`
	Projects       []struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Label string `json:"label"`
	} `json:"projects"`
}

// ConnectProject is the fields of GET /projects that connecting needs.
type ConnectProject struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Ref  string `json:"ref"`
	Box  struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"box"`
	Directory *string `json:"directory"`
	Sessions  *struct {
		Agent string `json:"agent"`
		Ctrl  string `json:"ctrl"`
	} `json:"sessions"`
	CreatedFor *string `json:"createdFor"`
}

// Ref is `devbox` (a box) or `devbox/fix` (a project on it); Box "" is the caller's only box.
type Ref struct {
	Box        string
	HasBox     bool
	Project    string
	HasProject bool
}

func parseRef(text string, defaultBox bool) (Ref, error) {
	if text == "" && defaultBox {
		return Ref{}, nil
	}
	if text == "" {
		return Ref{}, usageError("Name a box (`devbox`) or a project (`devbox/my-project`)")
	}
	parts := strings.Split(text, "/")
	bad := len(parts) > 2
	for _, p := range parts {
		if p == "" {
			bad = true
		}
	}
	if bad {
		return Ref{}, usageError(fmt.Sprintf("`%s` is neither a box (`devbox`) nor a project (`devbox/my-project`)", text))
	}
	r := Ref{Box: parts[0], HasBox: true}
	if len(parts) == 2 {
		r.Project, r.HasProject = parts[1], true
	}
	return r, nil
}

func addressableNames(boxes []ConnectBox) []string {
	var names []string
	for _, b := range boxes {
		if b.Addressable {
			names = append(names, b.Name)
		}
	}
	return names
}

// pickBox: a box by name or id; with no name (hasName false), the only box.
func pickBox(boxes []ConnectBox, name string, hasName bool) (*ConnectBox, error) {
	return pickBoxCase(boxes, name, hasName, false)
}

// pickBoxCase is target.ts's pickBox with its caseLost option. Names match without regard to
// case: an exact name wins, since names that differ only in case can coexist; failing that, one
// case-blind match is the box and several are ambiguous. With caseLost (a name OpenSSH
// lowercased, see pickProxyBox) an exact match proves nothing, so only the case-blind one counts.
func pickBoxCase(boxes []ConnectBox, name string, hasName, caseLost bool) (*ConnectBox, error) {
	names := addressableNames(boxes)
	if !hasName {
		switch len(boxes) {
		case 1:
			return &boxes[0], nil
		case 0:
			return nil, newErr("not_found", "You have no boxes; create one with `termag box create <name>`")
		}
		list := ""
		if len(names) > 0 {
			list = " (" + strings.Join(names, ", ") + ")"
		}
		return nil, usageError(fmt.Sprintf("You have %d boxes%s; name the one to use", len(boxes), list))
	}
	if !caseLost {
		for i := range boxes {
			if boxes[i].Name == name {
				return &boxes[i], nil
			}
		}
	}
	for i := range boxes {
		if boxes[i].ID == name {
			return &boxes[i], nil
		}
	}
	folded := strings.ToLower(name)
	var matches []*ConnectBox
	for i := range boxes {
		if strings.ToLower(boxes[i].Name) == folded {
			matches = append(matches, &boxes[i])
		}
	}
	switch {
	case len(matches) == 1:
		return matches[0], nil
	case len(matches) > 1:
		list := make([]string, len(matches))
		for i, b := range matches {
			list[i] = b.Name
		}
		if caseLost {
			return nil, usageError(fmt.Sprintf("\"%s\" matches %d boxes (%s) and ssh has lowercased it, so termag can't tell which;", name, len(matches), strings.Join(list, ", ")) +
				" run `termag ssh-config --install` again, which names each box by its instance id")
		}
		return nil, usageError(fmt.Sprintf("\"%s\" matches %d boxes (%s) when case is ignored; name one exactly, or by id", name, len(matches), strings.Join(list, ", ")))
	}
	tail := "; you have no boxes"
	if len(names) > 0 {
		tail = "; your boxes: " + strings.Join(names, ", ")
	}
	return nil, newErr("not_found", fmt.Sprintf("No box named \"%s\"%s", name, tail))
}

func pickProject(projects []ConnectProject, box *ConnectBox, name string) (*ConnectProject, error) {
	var names []string
	for i := range projects {
		if projects[i].Box.ID != box.ID {
			continue
		}
		if projects[i].Name == name {
			return &projects[i], nil
		}
		names = append(names, projects[i].Name)
	}
	tail := "; it has no projects"
	if len(names) > 0 {
		tail = "; its projects: " + strings.Join(names, ", ")
	}
	return nil, newErr("not_found", fmt.Sprintf("No project \"%s\" on %s%s", name, box.Name, tail))
}

// ssmTarget is the SSM target for a box, or why there isn't one right now.
func ssmTarget(box *ConnectBox, defaultRegion string) (instanceID, region string, err error) {
	if box.Kind != "ec2" || box.EC2InstanceID == nil || *box.EC2InstanceID == "" {
		return "", "", newErr("failed", box.Name+" is not an EC2 box, so termag can't reach it over SSM")
	}
	n := box.Name
	switch box.State {
	case "running", "unknown":
	case "stopped":
		return "", "", newErr("failed", fmt.Sprintf("%s is stopped; start it (`termag box start %s` or the web UI) and try again", n, n))
	case "stopping":
		return "", "", newErr("failed", n+" is stopping")
	case "hibernated":
		return "", "", newErr("failed", fmt.Sprintf("%s is hibernated; resume it (`termag box start %s` or the web UI), which keeps its sessions, and try again", n, n))
	case "hibernating":
		return "", "", newErr("failed", fmt.Sprintf("%s is hibernating; once it is hibernated, resume it with `termag box start %s` and try again", n, n))
	case "failed":
		e := ""
		if box.Error != nil && *box.Error != "" {
			e = ": " + *box.Error
		}
		return "", "", newErr("failed", n+" failed to come up"+e)
	default:
		return "", "", newErr("failed", fmt.Sprintf("%s is %s; try again once it is running", n, box.State))
	}
	region = defaultRegion
	if box.Region != nil && *box.Region != "" {
		region = *box.Region
	}
	return *box.EC2InstanceID, region, nil
}

// wakeAction is what `ssh-proxy --wake` does with a box in each state before it connects.
func wakeAction(state string) string {
	switch state {
	case "running", "unknown":
		return "connect"
	case "starting":
		return "wait"
	case "stopped", "hibernated":
		return "start"
	case "stopping", "hibernating":
		return "wait-then-start"
	}
	return "refuse"
}

// instanceIDRE: a box's instance id as EC2 writes it: what ssh-config puts on a HostName line,
// and ssh-proxy looks up.
var instanceIDRE = regexp.MustCompile(`^i-[0-9a-f]{8,17}$`)

const hostPrefix = "termag-"

func aliasFor(box *ConnectBox) string { return hostPrefix + box.Name }

// pickProxyBox: the box `termag ssh-proxy %h` is for. ssh-config's blocks make %h the box's
// instance id; an older block's %h is termag-<box>, lowercased by OpenSSH, so its name is matched
// with caseLost.
func pickProxyBox(boxes []ConnectBox, host string) (*ConnectBox, error) {
	id := strings.ToLower(host)
	if instanceIDRE.MatchString(id) {
		for i := range boxes {
			if boxes[i].EC2InstanceID != nil && strings.ToLower(*boxes[i].EC2InstanceID) == id {
				return &boxes[i], nil
			}
		}
		list := ""
		if names := addressableNames(boxes); len(names) > 0 {
			list = " (your boxes: " + strings.Join(names, ", ") + ")"
		}
		return nil, newErr("not_found", fmt.Sprintf("No box of yours is instance %s%s;", host, list)+
			" run `termag ssh-config --install` again to bring the ssh config up to date")
	}
	name, err := boxFromAlias(host)
	if err != nil {
		return nil, err
	}
	return pickBoxCase(boxes, name, true, true)
}

func boxFromAlias(alias string) (string, error) {
	if !strings.HasPrefix(alias, hostPrefix) || len(alias) == len(hostPrefix) {
		return "", usageError(fmt.Sprintf("`%s` is not a termag host; they are named %s<box>", alias, hostPrefix))
	}
	return alias[len(hostPrefix):], nil
}

// resolveBox is connect/commands.ts's: the authed client and the box by name (or the only one).
func resolveBox(c *Ctx, s *Session, name string, hasName bool) (*Api, *ConnectBox, error) {
	api, err := authedApi(c, s, 0)
	if err != nil {
		return nil, nil, err
	}
	var res struct {
		Boxes []ConnectBox `json:"boxes"`
	}
	if err := api.Request(context.Background(), "GET", "/boxes", nil, &res); err != nil {
		return nil, nil, err
	}
	box, err := pickBox(res.Boxes, name, hasName)
	return api, box, err
}

// resolveProxyBox is commands.ts's: the box ssh-proxy's %h names, an instance id (the ssh-config
// block's HostName), else termag-<box>. As in Node, the host is read only after GET /boxes.
func resolveProxyBox(c *Ctx, s *Session, host string) (*Api, *ConnectBox, error) {
	api, err := authedApi(c, s, 0)
	if err != nil {
		return nil, nil, err
	}
	var res struct {
		Boxes []ConnectBox `json:"boxes"`
	}
	if err := api.Request(context.Background(), "GET", "/boxes", nil, &res); err != nil {
		return nil, nil, err
	}
	box, err := pickProxyBox(res.Boxes, host)
	return api, box, err
}
