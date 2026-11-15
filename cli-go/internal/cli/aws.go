package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// connect/aws.ts: the AWS checks before an SSM connection (doctor runs the same ones).

type awsSettingsT struct {
	Profile, Document, DefaultRegion string
	// termag writes the profile itself; not for one named by TERMAG_AWS_PROFILE, which is the user's.
	WritesProfile bool
}

func awsSettings(env map[string]string) awsSettingsT {
	s := awsSettingsT{Profile: "termag-boxes", Document: "TermagSSH", DefaultRegion: "us-east-2", WritesProfile: true}
	if p := env["TERMAG_AWS_PROFILE"]; p != "" {
		s.Profile, s.WritesProfile = p, false
	}
	if d := env["TERMAG_SSM_DOCUMENT"]; d != "" {
		s.Document = d
	}
	return s
}

const (
	awsCLIInstall = "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
	pluginInstall = "https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html"
)

var (
	ssoProblemRE       = regexp.MustCompile(`(?i)sso|token|expired|credential|refresh`)
	unreadableCacheKey = regexp.MustCompile(`^(?:aws: \[ERROR\]: )?'([0-9a-f]{40})'$`)
)

func firstNonEmptyLine(text string) string {
	for _, l := range strings.Split(jsTrim(text), "\n") {
		if jsTrim(l) != "" {
			return jsTrim(l)
		}
	}
	return ""
}

func fsErr(err error) error {
	if err == nil {
		return nil
	}
	if _, ok := err.(*CliError); ok {
		return err
	}
	return newErr("failed", err.Error())
}

// ensureProfile writes termag's [sso-session] profile when the config has none by that name, and
// keeps an earlier termag-written one current.
func ensureProfile(c *Ctx, s awsSettingsT, awsPath string) (wrote, legacy bool, err error) {
	configPath := awsConfigPath(c.Env, c.Home)
	text, _, err := readIfExists(configPath)
	if err != nil {
		return false, false, fsErr(err)
	}
	state := awsProfileState(text, s.Profile)
	if state == "shadowed" {
		removed, err := removeAwsProfile(configPath)
		if err != nil {
			return false, false, fsErr(err)
		}
		b := ""
		if removed.Backup != nil {
			b = " (the previous file is " + *removed.Backup + ")"
		}
		c.Err(fmt.Sprintf("termag: %s has a %s profile (or [sso-session termag]) of its own as well as termag's, which the AWS CLI rejects; removed termag's%s", removed.Path, s.Profile, b))
		text, _, _ = readIfExists(configPath)
		state = awsProfileState(text, s.Profile)
	}
	profiles := captureCmd(awsPath, []string{"configure", "list-profiles"}, c.Env, 0)
	listedKnown := profiles.Code == 0
	listed := false
	if listedKnown {
		for _, l := range strings.Split(profiles.Stdout, "\n") {
			if jsTrim(l) == s.Profile {
				listed = true
			}
		}
	}
	if state != "managed" && (!listedKnown || listed) {
		return false, state == "own-legacy", nil
	}
	if state != "managed" && !s.WritesProfile {
		return false, false, newErr("failed", fmt.Sprintf("No `%s` profile in ~/.aws/config; add it as termag's USAGE.md shows (\"SSH from your laptop\")", s.Profile))
	}
	if state != "managed" {
		v := captureCmd(awsPath, []string{"--version"}, c.Env, 0)
		if ver, ok := parseAwsCliVersion(v.Stdout + " " + v.Stderr); ok && !supportsSsoSession(ver) {
			return false, false, newErr("failed", fmt.Sprintf("AWS CLI %d.%d predates the `[sso-session]` profile termag sets up; install %d.%d or later: %s", ver[0], ver[1], minAwsCLI[0], minAwsCLI[1], awsCLIInstall))
		}
	}
	res, err := installAwsProfile(configPath, s.Profile)
	if err != nil {
		return false, false, fsErr(err)
	}
	if res.Action == "unchanged" {
		return false, false, nil
	}
	verb := "updated"
	if res.Action == "added" {
		verb = "added"
	}
	b := ""
	if res.Backup != nil {
		b = " (the previous file is " + *res.Backup + ")"
	}
	c.Err(fmt.Sprintf("termag: %s the %s AWS profile in %s%s; one AWS sign-in now lasts the access-portal session", verb, s.Profile, res.Path, b))
	return true, false, nil
}

// preflight: the AWS CLI, the Session Manager plugin, the profile and a live SSO session. It
// returns the AWS CLI's path; `aws sso login` runs only when interactive.
func preflight(c *Ctx, s awsSettingsT, interactive bool, loginStdio attachedStdio) (string, error) {
	awsPath := findTool("aws", c.Env, false)
	if awsPath == "" {
		return "", newErr("failed", "The AWS CLI (v2) is needed to reach boxes over SSM; install it: "+awsCLIInstall)
	}
	if findTool("session-manager-plugin", c.Env, false) == "" {
		return "", newErr("failed", "The AWS Session Manager plugin is needed to reach boxes; install session-manager-plugin: "+pluginInstall)
	}
	wrote, legacy, err := ensureProfile(c, s, awsPath)
	if err != nil {
		return "", err
	}
	identityArgs := []string{"sts", "get-caller-identity", "--profile", s.Profile, "--output", "json"}
	identity := captureCmd(awsPath, identityArgs, c.Env, 0)
	if identity.Code == 0 {
		return awsPath, nil
	}
	reason := firstNonEmptyLine(identity.Stderr)
	corrupted := false
	if m := unreadableCacheKey.FindStringSubmatch(reason); m != nil {
		_, err := os.Stat(filepath.Join(c.Home, ".aws", "sso", "cache", m[1]+".json"))
		corrupted = err == nil
	}
	if !corrupted && !ssoProblemRE.MatchString(reason) {
		why := reason
		if why == "" {
			why = fmt.Sprintf("aws exited %d", identity.Code)
		}
		return "", newErr("failed", fmt.Sprintf("AWS profile `%s` does not work: %s", s.Profile, why))
	}
	login := "aws sso login --profile " + s.Profile
	why := "has an expired AWS SSO session"
	switch {
	case corrupted:
		why = "has a corrupted AWS SSO token cache"
	case wrote:
		why = "has no AWS SSO session yet"
	}
	if legacy {
		c.Err(fmt.Sprintf("termag: your %s profile uses the legacy sso_start_url form, so each sign-in lasts one access token; delete it from ~/.aws/config and termag writes the [sso-session] form, which renews itself, on the next connect", s.Profile))
	}
	if !interactive {
		return "", newErr("auth_required", fmt.Sprintf("`%s` %s; run `%s`", s.Profile, why, login))
	}
	c.Err(fmt.Sprintf("termag: %s %s; running `%s`", s.Profile, why, login))
	if code := runAttached(c, awsPath, []string{"sso", "login", "--profile", s.Profile}, c.Env, loginStdio); code != 0 {
		return "", newErr("auth_required", fmt.Sprintf("`%s` did not finish (exit %d)", login, code))
	}
	again := captureCmd(awsPath, identityArgs, c.Env, 0)
	if again.Code != 0 {
		return "", newErr("auth_required", fmt.Sprintf("AWS profile `%s` still has no session after `%s`: %s", s.Profile, login, firstNonEmptyLine(again.Stderr)))
	}
	return awsPath, nil
}
