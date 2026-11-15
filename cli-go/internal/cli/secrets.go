package cli

import (
	"fmt"
	"regexp"
	"strings"
)

// A copy of cli/src/secretPatterns.ts (itself a copy of the backend's): the secret-shaped strings
// space memory refuses and withholds, and that bug report redacts. secrets_test.go checks the
// list against the TS source.
//
// JS's \b is ASCII-only, as RE2's is, so the patterns carry over as they are.
var secretPatterns = []struct {
	re   *regexp.Regexp
	what string
}{
	{regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`), "AWS access key id"},
	{regexp.MustCompile(`\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b`), "GitHub token"},
	{regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{60,}\b`), "GitHub token"},
	{regexp.MustCompile(`\btmag_[A-Za-z0-9]{16,}\b`), "termag agent token"},
	{regexp.MustCompile(`\btmcli_[A-Za-z0-9]{16,}\b`), "termag CLI token"},
	{regexp.MustCompile(`\bxox[abposr]-[A-Za-z0-9-]{10,}\b`), "Slack token"},
	{regexp.MustCompile(`\bsk-ant-[A-Za-z0-9_-]{20,}\b`), "Anthropic key"},
	{regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`), "private key"},
}

// findSecretsInText: the kinds of secret-shaped strings on any line of a text.
func findSecretsInText(text string) []string {
	var found []string
	seen := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		for _, s := range secretPatterns {
			if !seen[s.what] && s.re.MatchString(line) {
				seen[s.what] = true
				found = append(found, s.what)
			}
		}
	}
	return found
}

// pemBlockStart finds a PEM private key's BEGIN line; RE2 has no backreference, so the matching
// END line is looked for by hand (secretPatterns.ts PEM_PRIVATE_KEY_BLOCK).
var pemBlockStart = regexp.MustCompile(`-----BEGIN ([A-Z ]*)PRIVATE KEY-----`)

func redactPEM(text string, found func()) string {
	var b strings.Builder
	for {
		loc := pemBlockStart.FindStringSubmatchIndex(text)
		if loc == nil {
			b.WriteString(text)
			return b.String()
		}
		found()
		b.WriteString(text[:loc[0]])
		b.WriteString("[redacted: private key]")
		end := "-----END " + text[loc[2]:loc[3]] + "PRIVATE KEY-----"
		rest := text[loc[1]:]
		if i := strings.Index(rest, end); i >= 0 {
			text = rest[i+len(end):]
		} else {
			return b.String() // to the end of the text (cut-off output)
		}
	}
}

// redactSecrets replaces every secret-shaped string with `[redacted: <what>]`.
func redactSecrets(text string) (string, []string) {
	var kinds []string
	seen := map[string]bool{}
	add := func(w string) {
		if !seen[w] {
			seen[w] = true
			kinds = append(kinds, w)
		}
	}
	out := redactPEM(text, func() { add("private key") })
	for _, s := range secretPatterns {
		what := s.what
		out = s.re.ReplaceAllStringFunc(out, func(string) string { add(what); return "[redacted: " + what + "]" })
	}
	return out, kinds
}

// secretReason (spaceMemory.ts): the first secret kind in a file and its line.
func secretReason(text string) string {
	for i, line := range strings.Split(text, "\n") {
		if found := findSecretsInText(line); len(found) > 0 {
			return fmt.Sprintf("looks like a %s (line %d)", found[0], i+1)
		}
	}
	return ""
}

const memoryRoot = ".termag/"

var memoryNotScanned = []string{memoryRoot + "tools/", memoryRoot + "automations/"}

// memoryPutRefusal (spaceMemory.ts): `space put` of a secret into the memory folder is refused.
func memoryPutRefusal(remotePath, text string) string {
	if !strings.HasPrefix(remotePath, memoryRoot) {
		return ""
	}
	for _, r := range memoryNotScanned {
		if strings.HasPrefix(remotePath, r) {
			return ""
		}
	}
	if reason := secretReason(text); reason != "" {
		return fmt.Sprintf("%s %s; space memory is read by every member's agents. Remove the secret first", remotePath, reason)
	}
	return ""
}
