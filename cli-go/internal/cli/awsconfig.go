package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// connect/awsConfig.ts: termag's `[sso-session termag]` + `[profile termag-boxes]` block in
// ~/.aws/config, written only when the config has no such profile.

const (
	awsBeginMarker = "# >>> termag aws-config >>>"
	awsEndMarker   = "# <<< termag aws-config <<<"
)

var awsManaged = managedBlock{awsBeginMarker, awsEndMarker, "~/.aws/config", "termag ssh <box>", false}

// The SSO sign-in for the AWS account the boxes run in, as connect/awsConfig.ts has it: set
// TERMAG_SSO_START_URL and TERMAG_AWS_ACCOUNT to your organization's; the defaults are placeholders.
const (
	termagSSOSession   = "termag"
	termagSSORegion    = "us-east-1"
	termagSSORoleName  = "TermagUser"
	termagSSOAwsRegion = "us-east-2"
)

var (
	termagSSOStartURL  = envOr("TERMAG_SSO_START_URL", "https://your-org.awsapps.com/start/")
	termagSSOAccountID = envOr("TERMAG_AWS_ACCOUNT", "123456789012")
)

// The variable's value, or def when it is unset or empty (the Node CLI's `||`).
func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

// `[sso-session]` needs AWS CLI 2.9 or later.
var minAwsCLI = [2]int{2, 9}

func awsConfigPath(env map[string]string, home string) string {
	if p := env["AWS_CONFIG_FILE"]; p != "" {
		return p
	}
	return filepath.Join(home, ".aws", "config")
}

func renderAwsBlock(profile string) string {
	return strings.Join([]string{
		awsBeginMarker,
		"# Written by the termag CLI the first time it connects to a box; it replaces everything between these markers.",
		"[sso-session " + termagSSOSession + "]",
		"sso_start_url = " + termagSSOStartURL,
		"sso_region = " + termagSSORegion,
		"sso_registration_scopes = sso:account:access",
		"",
		"[profile " + profile + "]",
		"sso_session = " + termagSSOSession,
		"sso_account_id = " + termagSSOAccountID,
		"sso_role_name = " + termagSSORoleName,
		"region = " + termagSSOAwsRegion,
		awsEndMarker,
	}, "\n")
}

var awsCLIVersionRE = regexp.MustCompile(`aws-cli/(\d+)\.(\d+)`)

// parseAwsCliVersion: `aws-cli/2.15.30 Python/3.11.8 …` → 2, 15.
func parseAwsCliVersion(text string) ([2]int, bool) {
	m := awsCLIVersionRE.FindStringSubmatch(text)
	if m == nil {
		return [2]int{}, false
	}
	a, _ := strconv.Atoi(m[1])
	b, _ := strconv.Atoi(m[2])
	return [2]int{a, b}, true
}

func supportsSsoSession(v [2]int) bool {
	return v[0] > minAwsCLI[0] || (v[0] == minAwsCLI[0] && v[1] >= minAwsCLI[1])
}

type awsSection struct {
	kind, name string
	keys       map[string]string
	managed    bool
}

var (
	awsHeaderRE = regexp.MustCompile(`^\[\s*(?:(profile|sso-session)\s+)?([^\]]+?)\s*\]$`)
	awsKVRE     = regexp.MustCompile(`^([^=\s]+)\s*=\s*(.*)$`)
)

func awsSections(content string) []*awsSection {
	var out []*awsSection
	managed := false
	var current *awsSection
	for _, raw := range strings.Split(content, "\n") {
		line := jsTrim(raw)
		if line == awsBeginMarker {
			managed = true
			continue
		}
		if line == awsEndMarker {
			managed = false
			current = nil
			continue
		}
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if h := awsHeaderRE.FindStringSubmatch(line); h != nil {
			kind := h[1]
			if kind == "" {
				kind = "profile"
			}
			current = &awsSection{kind: kind, name: h[2], keys: map[string]string{}, managed: managed}
			out = append(out, current)
			continue
		}
		if kv := awsKVRE.FindStringSubmatch(line); kv != nil && current != nil {
			current.keys[strings.ToLower(kv[1])] = kv[2]
		}
	}
	return out
}

// awsProfileState: missing, managed (between termag's markers), own, own-legacy (sso_start_url in
// the profile), or shadowed (termag's block and the user's own section by the same name).
func awsProfileState(content, profile string) string {
	all := awsSections(content)
	var found []*awsSection
	ours := false
	for _, s := range all {
		if s.kind == "profile" && s.name == profile {
			found = append(found, s)
			if s.managed {
				ours = true
			}
		}
	}
	if len(found) == 0 {
		return "missing"
	}
	theirs := 0
	for _, s := range all {
		if !s.managed && ((s.kind == "profile" && s.name == profile) || (s.kind == "sso-session" && s.name == termagSSOSession)) {
			theirs++
		}
	}
	if ours && theirs > 0 {
		return "shadowed"
	}
	if ours {
		return "managed"
	}
	_, start := found[0].keys["sso_start_url"]
	_, sess := found[0].keys["sso_session"]
	if start && !sess {
		return "own-legacy"
	}
	return "own"
}

func removeAwsProfile(p string) (installResult, error) { return removeBlock(p, awsManaged) }

// installAwsProfile adds termag's profile, or brings an earlier termag-written one up to date;
// it refuses rather than shadow a session or profile of the user's own.
func installAwsProfile(p, profile string) (installResult, error) {
	existing, _, err := readIfExists(p)
	if err != nil {
		return installResult{}, err
	}
	for _, s := range awsSections(existing) {
		if s.managed {
			continue
		}
		if s.kind == "sso-session" && s.name == termagSSOSession {
			return installResult{}, newErr("failed", fmt.Sprintf("%s already has an `[sso-session %s]` of its own; add a `%s` profile that uses it, or rename it", p, termagSSOSession, profile))
		}
	}
	for _, s := range awsSections(existing) {
		if !s.managed && s.kind == "profile" && s.name == profile {
			return installResult{}, newErr("failed", fmt.Sprintf("%s already has its own `%s` profile; termag leaves it alone", p, profile))
		}
	}
	return installBlock(p, renderAwsBlock(profile), awsManaged)
}
