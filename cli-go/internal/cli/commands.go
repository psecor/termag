package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

type userView struct {
	Email        string `json:"email"`
	UnixUsername string `json:"unixUsername"`
	DisplayName  string `json:"displayName"`
}

// whoamiResponse keeps the server's own JSON for --json, and reads what the lines need.
type whoamiResponse struct {
	raw  *Object
	User struct {
		Email        string `json:"email"`
		UnixUsername string `json:"unixUsername"`
	} `json:"user"`
	Credential struct {
		Kind         string `json:"kind"`
		DeviceName   string `json:"deviceName"`
		ExpiresAt    string `json:"expiresAt"`
		MaxExpiresAt string `json:"maxExpiresAt"`
	} `json:"credential"`
}

func getWhoami(api *Api) (*whoamiResponse, error) {
	raw, err := api.RequestRaw(context.Background(), "GET", "/whoami", nil)
	if err != nil {
		return nil, err
	}
	w := &whoamiResponse{raw: newObject()}
	if err := json.Unmarshal(raw, w); err != nil {
		return nil, newErr("failed", "Unexpected /whoami answer")
	}
	_ = w.raw.UnmarshalJSON(raw)
	return w, nil
}

// withHost is `{ host, ...obj }`.
func withHost(host string, obj *Object) *Object {
	o := newObject().Set("host", host)
	for _, k := range obj.Keys() {
		if k == "host" {
			continue
		}
		v, _ := obj.Get(k)
		o.Set(k, v)
	}
	if v, ok := obj.Get("host"); ok {
		o.Set("host", v) // a server `host` wins, as a spread does, but keeps the first position
	}
	return o
}

func describeCredential(w *whoamiResponse) string {
	if w.Credential.Kind == "device" {
		return fmt.Sprintf("device sign-in \"%s\", lapses %s if unused (at the latest %s)", w.Credential.DeviceName, FormatDate(w.Credential.ExpiresAt), FormatDate(w.Credential.MaxExpiresAt))
	}
	return "this box's own credentials"
}

func cmdWhoami(c *Ctx, a *ParsedArgs) (int, error) {
	s, err := newSession(c, a)
	if err != nil {
		return 0, err
	}
	api, err := authedApi(c, s, 0)
	if err != nil {
		return 0, err
	}
	w, err := getWhoami(api)
	if err != nil {
		return 0, err
	}
	if a.JSON {
		c.Out(JSONText(withHost(s.Target.Host, w.raw)))
	} else {
		c.Out(fmt.Sprintf("%s (%s) on %s", w.User.Email, w.User.UnixUsername, s.Target.Host))
		c.Out("via " + describeCredential(w))
	}
	return ExitOK, nil
}

func cmdLogout(c *Ctx, a *ParsedArgs) (int, error) {
	s, err := newSession(c, a)
	if err != nil {
		return 0, err
	}
	login := LoadLogin(s.CredsPath, s.Target.Host)
	if login == nil {
		msg := fmt.Sprintf("Not signed in to %s.", s.Target.Host)
		if s.Target.Box != nil {
			msg = fmt.Sprintf("Not signed in to %s with `termag login`; this box's own credentials stay in place.", s.Target.Host)
		}
		if a.JSON {
			c.Out(JSONText(newObject().Set("host", s.Target.Host).Set("signedOut", false)))
		} else {
			c.Out(msg)
		}
		return ExitOK, nil
	}
	revoked := true
	tok, err := freshAccess(context.Background(), c, s.Target.Host, s.CredsPath, login, "", 0)
	if err == nil {
		err = (&Api{Host: s.Target.Host, Token: tok, Client: c.HTTP}).Request(context.Background(), "DELETE", "/token", nil, nil)
	}
	if err != nil {
		// A token the server already refuses is as good as revoked.
		if ce, ok := err.(*CliError); !ok || ce.Code != "auth_required" {
			revoked = false
		}
	}
	if _, err := RemoveLogin(s.CredsPath, s.Target.Host); err != nil {
		return 0, newErr("failed", err.Error())
	}
	if a.JSON {
		c.Out(JSONText(newObject().Set("host", s.Target.Host).Set("signedOut", true).Set("revoked", revoked)))
	} else {
		c.Out(fmt.Sprintf("Signed out of %s.", s.Target.Host))
	}
	if !revoked {
		c.Err(fmt.Sprintf("termag: could not reach %s to revoke the token; sign \"%s\" out in the web UI (Settings, CLI sign-ins).", s.Target.Host, login.DeviceName()))
	}
	return ExitOK, nil
}

var requirementsRE = regexp.MustCompile(`^(\d+)vcpu-(\d+)gib$`)

func requirementsText(size string) string {
	if m := requirementsRE.FindStringSubmatch(size); m != nil {
		return m[1] + " vCPU, " + m[2] + " GB"
	}
	return size
}

type boxRow struct {
	Name           string  `json:"name"`
	Addressable    bool    `json:"addressable"`
	State          string  `json:"state"`
	AgentConnected bool    `json:"agentConnected"`
	Error          *string `json:"error"`
	SetupEnabled   *bool   `json:"setupEnabled"`
	Projects       []struct {
		Name  string `json:"name"`
		Label string `json:"label"`
	} `json:"projects"`
	Size         *string  `json:"size"`
	InstanceType *string  `json:"instanceType"`
	DiskGiB      *float64 `json:"diskGiB"`
	Resize       *struct {
		To      *string `json:"to"`
		Phase   *string `json:"phase"`
		Running bool    `json:"running"`
	} `json:"resize"`
}

func strOr(p *string, def string) string {
	if p == nil {
		return def
	}
	return *p
}

// jsString is String(v) for a value that may be null.
func jsString(p *string) string { return strOr(p, "null") }

func boxSizeCell(b *boxRow) string {
	size := strOr(b.Size, "")
	if size != "" && requirementsRE.MatchString(size) {
		if b.InstanceType != nil {
			return *b.InstanceType
		}
		return requirementsText(size)
	}
	if size != "" {
		if b.InstanceType != nil && *b.InstanceType != "" {
			return size + " (" + *b.InstanceType + ")"
		}
		return size
	}
	if b.InstanceType != nil {
		return *b.InstanceType
	}
	return "-"
}

func cmdBoxList(c *Ctx, a *ParsedArgs) (int, error) {
	s, err := newSession(c, a)
	if err != nil {
		return 0, err
	}
	api, err := authedApi(c, s, 0)
	if err != nil {
		return 0, err
	}
	var res struct {
		Boxes []json.RawMessage `json:"boxes"`
	}
	if err := api.Request(context.Background(), "GET", "/boxes", nil, &res); err != nil {
		return 0, err
	}
	if res.Boxes == nil {
		res.Boxes = []json.RawMessage{}
	}
	if a.JSON {
		c.Out(JSONText(newObject().Set("boxes", res.Boxes)))
		return ExitOK, nil
	}
	if len(res.Boxes) == 0 {
		c.Out("No boxes. Create one with `termag box create <name>`.")
		return ExitOK, nil
	}
	var rows [][]string
	var unaddressable []string
	for _, raw := range res.Boxes {
		var b boxRow
		_ = json.Unmarshal(raw, &b)
		state := b.State
		if b.State == "failed" && b.Error != nil && *b.Error != "" {
			state = "failed: " + *b.Error
		}
		size := boxSizeCell(&b)
		if b.Resize != nil && b.Resize.Running {
			size = fmt.Sprintf("%s -> %s (%s)", boxSizeCell(&b), jsString(b.Resize.To), jsString(b.Resize.Phase))
		}
		if b.SetupEnabled != nil && !*b.SetupEnabled {
			size += ", setup off"
		}
		disk := "-"
		if b.DiskGiB != nil && *b.DiskGiB != 0 {
			disk = fmt.Sprintf("%s GB", jsNumber(*b.DiskGiB))
		}
		agent := "-"
		if b.AgentConnected {
			agent = "connected"
		}
		var names []string
		for _, p := range b.Projects {
			if p.Label != "" {
				names = append(names, p.Name+" ("+p.Label+")")
			} else {
				names = append(names, p.Name)
			}
		}
		projects := strings.Join(names, ", ")
		if projects == "" {
			projects = "-"
		}
		rows = append(rows, []string{b.Name, state, size, disk, agent, projects})
		if !b.Addressable {
			unaddressable = append(unaddressable, `"`+b.Name+`"`)
		}
	}
	c.Out(Table([]string{"BOX", "STATE", "SIZE", "DISK", "AGENT", "PROJECTS"}, rows))
	if len(unaddressable) > 0 {
		c.Err(fmt.Sprintf("termag: %s can't be used as a box name on the command line (letters, digits, - and _ only); rename in the web UI.", strings.Join(unaddressable, ", ")))
	}
	return ExitOK, nil
}

func cmdProjectList(c *Ctx, a *ParsedArgs) (int, error) {
	s, err := newSession(c, a)
	if err != nil {
		return 0, err
	}
	api, err := authedApi(c, s, 0)
	if err != nil {
		return 0, err
	}
	var res struct {
		Projects []json.RawMessage `json:"projects"`
	}
	if err := api.Request(context.Background(), "GET", "/projects", nil, &res); err != nil {
		return 0, err
	}
	if res.Projects == nil {
		res.Projects = []json.RawMessage{}
	}
	if a.JSON {
		c.Out(JSONText(newObject().Set("projects", res.Projects)))
		return ExitOK, nil
	}
	if len(res.Projects) == 0 {
		c.Out("No projects.")
		return ExitOK, nil
	}
	var rows [][]string
	for _, raw := range res.Projects {
		var p struct {
			Ref           string  `json:"ref"`
			Provider      *string `json:"provider"`
			Status        string  `json:"status"`
			WaitingReason *string `json:"waitingReason"`
		}
		_ = json.Unmarshal(raw, &p)
		status := strings.Replace(p.Status, "_", " ", 1) // JS .replace('_', ' '): the first one only
		if p.Status == "waiting" && p.WaitingReason != nil && *p.WaitingReason != "" {
			status = "waiting (" + *p.WaitingReason + ")"
		}
		rows = append(rows, []string{p.Ref, strOr(p.Provider, "-"), status})
	}
	c.Out(Table([]string{"PROJECT", "AGENT", "STATUS"}, rows))
	return ExitOK, nil
}
