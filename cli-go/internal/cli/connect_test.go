package cli

import (
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"testing"
)

// Golden tests against the Node CLI's own connect functions (testdata/connect.json, written by
// tools/genconnect.mjs).

type sshcFixtures struct {
	ShQuote []struct {
		Input, OK string
	} `json:"shQuote"`
	RemoteCommandLine []struct {
		Input []string `json:"input"`
		OK    *string  `json:"ok"`
	} `json:"remoteCommandLine"`
	ScanSshOptions []struct {
		Input []string `json:"input"`
		Flags []string `json:"flags"`
		Stray []string `json:"stray"`
	} `json:"scanSshOptions"`
	BuildSshArgv []struct {
		Plan struct {
			Route struct {
				AwsPath, InstanceID, Region, Profile, Document string
			} `json:"route"`
			Alias       string   `json:"alias"`
			User        string   `json:"user"`
			UserOptions []string `json:"userOptions"`
			Remote      *string  `json:"remote"`
			TTY         bool     `json:"tty"`
			Batch       bool     `json:"batch"`
		} `json:"plan"`
		OK []string `json:"ok"`
	} `json:"buildSshArgv"`
	ProxyCommandFor []struct {
		Termag []string `json:"termag"`
		Host   *string  `json:"host"`
		Wake   bool     `json:"wake"`
		OK     string   `json:"ok"`
	} `json:"proxyCommandFor"`
	SshHosts struct {
		Boxes    []ConnectBox     `json:"boxes"`
		Projects []ConnectProject `json:"projects"`
		User     string           `json:"user"`
		OK       struct {
			BoxHosts []struct {
				Alias    string  `json:"alias"`
				HostName *string `json:"hostName"`
				User     *string `json:"user"`
			} `json:"boxHosts"`
			SessionHosts []struct {
				Alias, HostName, User, Session string
			} `json:"sessionHosts"`
			Skipped []string `json:"skipped"`
		} `json:"ok"`
		Block string `json:"block"`
	} `json:"sshHosts"`
	UpsertBlock []struct {
		Existing string `json:"existing"`
		Top      bool   `json:"top"`
		Block    string `json:"block"`
		OK       *struct {
			Content string `json:"content"`
			Action  string `json:"action"`
		} `json:"ok"`
		Error string `json:"error"`
	} `json:"upsertBlock"`
	DropBlock []struct {
		Existing string `json:"existing"`
		OK       struct {
			Content string `json:"content"`
			Action  string `json:"action"`
		} `json:"ok"`
	} `json:"dropBlock"`
	AwsBlock     string `json:"awsBlock"`
	ProfileState []struct {
		Content, OK string
	} `json:"profileState"`
	AwsVersion []struct {
		Input    string `json:"input"`
		Version  []int  `json:"version"`
		Supports *bool  `json:"supports"`
	} `json:"awsVersion"`
	WithTerminfo   struct{ OK string } `json:"withTerminfo"`
	FallbackNotice string              `json:"fallbackNotice"`
	ParseRef       []struct {
		Input string `json:"input"`
		OK    *struct {
			Box     *string `json:"box"`
			Project *string `json:"project"`
		} `json:"ok"`
		Error string `json:"error"`
	} `json:"parseRef"`
	SsmTarget []struct {
		State string `json:"state"`
		OK    *struct {
			InstanceID string `json:"instanceId"`
			Region     string `json:"region"`
		} `json:"ok"`
		Error string `json:"error"`
	} `json:"ssmTarget"`
	PickBox []struct {
		Name     *string `json:"name"`
		N        int     `json:"n"`
		CaseLost bool    `json:"caseLost"`
		OK       string  `json:"ok"`
		Error    string  `json:"error"`
		Code     string  `json:"code"`
	} `json:"pickBox"`
	PickProxyBox []struct {
		Host  string `json:"host"`
		OK    string `json:"ok"`
		Error string `json:"error"`
		Code  string `json:"code"`
	} `json:"pickProxyBox"`
	BoxFromAlias []struct {
		Input, OK, Error string
	} `json:"boxFromAlias"`
}

func sshcLoad(t *testing.T) sshcFixtures {
	t.Helper()
	raw, err := os.ReadFile("testdata/connect.json")
	if err != nil {
		t.Fatal(err)
	}
	var f sshcFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestSshcArgvMatchesNode(t *testing.T) {
	f := sshcLoad(t)
	for _, tc := range f.ShQuote {
		if got := shQuote(tc.Input); got != tc.OK {
			t.Errorf("shQuote(%q) = %q, want %q", tc.Input, got, tc.OK)
		}
	}
	for _, tc := range f.RemoteCommandLine {
		got, ok := remoteCommandLine(tc.Input)
		if (tc.OK == nil) == ok || (ok && got != *tc.OK) {
			t.Errorf("remoteCommandLine(%q) = %q %v", tc.Input, got, ok)
		}
	}
	for _, tc := range f.ScanSshOptions {
		s := scanSshOptions(tc.Input)
		var flags []string
		for k := range s.flags {
			flags = append(flags, string(k))
		}
		sort.Strings(flags)
		if flags == nil {
			flags = []string{}
		}
		stray := s.stray
		if stray == nil {
			stray = []string{}
		}
		if !reflect.DeepEqual(flags, tc.Flags) || !reflect.DeepEqual(stray, tc.Stray) {
			t.Errorf("scanSshOptions(%q) = %v %v, want %v %v", tc.Input, flags, stray, tc.Flags, tc.Stray)
		}
	}
	for _, tc := range f.BuildSshArgv {
		p := tc.Plan
		plan := sshPlan{Route: ssmRoute(p.Route), Alias: p.Alias, User: p.User, UserOptions: p.UserOptions, TTY: p.TTY, Batch: p.Batch}
		if p.Remote != nil {
			plan.Remote, plan.HasRemote = *p.Remote, true
		}
		if got := buildSshArgv(plan); !reflect.DeepEqual(got, tc.OK) {
			t.Errorf("buildSshArgv:\n got %q\nwant %q", got, tc.OK)
		}
	}
	for _, tc := range f.ProxyCommandFor {
		host := ""
		if tc.Host != nil {
			host = *tc.Host
		}
		if got := proxyCommandFor(tc.Termag, host, tc.Wake); got != tc.OK {
			t.Errorf("proxyCommandFor(%q) = %q, want %q", tc.Termag, got, tc.OK)
		}
	}
	if got := withTerminfo("xterm-ghostty", "xterm-ghostty|ghostty,\n\tam, bce,\n", loginShell); got != f.WithTerminfo.OK {
		t.Errorf("withTerminfo:\n%q\nwant\n%q", got, f.WithTerminfo.OK)
	}
	if got := fallbackNotice(termPlan{Kind: "fallback", Term: "weird", Reason: "because"}); got != f.FallbackNotice {
		t.Errorf("fallbackNotice %q", got)
	}
}

func TestSshcConfigBlockMatchesNode(t *testing.T) {
	f := sshcLoad(t)
	h := f.SshHosts
	got := sshHosts(h.User, h.Boxes, h.Projects)
	b, _ := json.Marshal(struct {
		BoxHosts     []sshBoxHost     `json:"boxHosts"`
		SessionHosts []sshSessionHost `json:"sessionHosts"`
		Skipped      []string         `json:"skipped"`
	}{got.BoxHosts, got.SessionHosts, got.Skipped})
	w, _ := json.Marshal(h.OK)
	var gv, wv any
	_ = json.Unmarshal(b, &gv)
	_ = json.Unmarshal(w, &wv)
	if !reflect.DeepEqual(gv, wv) {
		t.Errorf("sshHosts:\n got %s\nwant %s", b, w)
	}
	block := renderSshBlock(proxyCommandFor([]string{"/home/ab/.local/bin/termag"}, "", false), "ab", got.BoxHosts, got.SessionHosts)
	if block != h.Block {
		t.Errorf("block:\n%s\nwant\n%s", block, h.Block)
	}
	for i, tc := range f.UpsertBlock {
		m := sshManaged
		if !tc.Top {
			m = awsManaged
		}
		content, action, err := upsertBlock(tc.Existing, tc.Block, m)
		if tc.Error != "" {
			if err == nil || err.Error() != tc.Error {
				t.Errorf("upsert %d: want error %q, got %v", i, tc.Error, err)
			}
			continue
		}
		if err != nil || content != tc.OK.Content || action != tc.OK.Action {
			t.Errorf("upsert %d: %q %q %v\nwant %q %q", i, content, action, err, tc.OK.Content, tc.OK.Action)
		}
	}
	for i, tc := range f.DropBlock {
		if c, a := dropBlock(tc.Existing, awsManaged); c != tc.OK.Content || a != tc.OK.Action {
			t.Errorf("drop %d: %q %q, want %q %q", i, c, a, tc.OK.Content, tc.OK.Action)
		}
	}
}

func TestSshcAwsConfigMatchesNode(t *testing.T) {
	f := sshcLoad(t)
	if got := renderAwsBlock("termag-boxes"); got != f.AwsBlock {
		t.Errorf("aws block:\n%s", got)
	}
	for _, tc := range f.ProfileState {
		if got := awsProfileState(tc.Content, "termag-boxes"); got != tc.OK {
			t.Errorf("profileState(%q) = %s, want %s", tc.Content, got, tc.OK)
		}
	}
	for _, tc := range f.AwsVersion {
		v, ok := parseAwsCliVersion(tc.Input)
		if ok != (tc.Version != nil) || (ok && (v[0] != tc.Version[0] || v[1] != tc.Version[1] || supportsSsoSession(v) != *tc.Supports)) {
			t.Errorf("aws version %q: %v %v", tc.Input, v, ok)
		}
	}
}

func TestSshcTargetsMatchNode(t *testing.T) {
	f := sshcLoad(t)
	for _, tc := range f.ParseRef {
		r, err := parseRef(tc.Input, false)
		if tc.Error != "" {
			if err == nil || err.Error() != tc.Error {
				t.Errorf("parseRef(%q): want %q, got %v", tc.Input, tc.Error, err)
			}
			continue
		}
		if err != nil || r.Box != *tc.OK.Box || (tc.OK.Project == nil) == r.HasProject || (r.HasProject && r.Project != *tc.OK.Project) {
			t.Errorf("parseRef(%q) = %+v %v", tc.Input, r, err)
		}
	}
	for _, tc := range f.SsmTarget {
		box := &ConnectBox{Name: "dev", Kind: "ec2", EC2InstanceID: sshcStr("i-1"), State: tc.State}
		if tc.State == "external" {
			box = &ConnectBox{Name: "dev", Kind: "external", State: "running"}
		}
		if tc.State == "failed" {
			box.Error = sshcStr("boom")
		}
		id, region, err := ssmTarget(box, "us-east-2")
		if tc.Error != "" {
			if err == nil || err.Error() != tc.Error {
				t.Errorf("ssmTarget(%s): want %q, got %v", tc.State, tc.Error, err)
			}
			continue
		}
		if err != nil || id != tc.OK.InstanceID || region != tc.OK.Region {
			t.Errorf("ssmTarget(%s) = %s %s %v", tc.State, id, region, err)
		}
	}
	boxes := f.SshHosts.Boxes
	for _, tc := range f.PickBox {
		list := boxes[:tc.N]
		name, has := "", tc.Name != nil
		if has {
			name = *tc.Name
		}
		b, err := pickBoxCase(list, name, has, tc.CaseLost)
		if tc.Error != "" {
			ce, _ := err.(*CliError)
			if ce == nil || ce.Message != tc.Error || ce.Code != tc.Code {
				t.Errorf("pickBox(%v, caseLost %v): want %q, got %v", tc.Name, tc.CaseLost, tc.Error, err)
			}
			continue
		}
		if err != nil || b.ID != tc.OK {
			t.Errorf("pickBox(%v, caseLost %v) = %v %v", tc.Name, tc.CaseLost, b, err)
		}
	}
	for _, tc := range f.PickProxyBox {
		b, err := pickProxyBox(boxes, tc.Host)
		if tc.Error != "" {
			ce, _ := err.(*CliError)
			if ce == nil || ce.Message != tc.Error || ce.Code != tc.Code {
				t.Errorf("pickProxyBox(%q): want %q (%s), got %v", tc.Host, tc.Error, tc.Code, err)
			}
			continue
		}
		if err != nil || b.ID != tc.OK {
			t.Errorf("pickProxyBox(%q) = %v %v, want %s", tc.Host, b, err, tc.OK)
		}
	}
	for _, tc := range f.BoxFromAlias {
		got, err := boxFromAlias(tc.Input)
		if tc.Error != "" {
			if err == nil || err.Error() != tc.Error {
				t.Errorf("boxFromAlias(%q): %v", tc.Input, err)
			}
		} else if err != nil || got != tc.OK {
			t.Errorf("boxFromAlias(%q) = %q %v", tc.Input, got, err)
		}
	}
}

func sshcStr(s string) *string { return &s }
