package main

// The app's environment is built, not inherited. Landlock doesn't cover
// environment variables, so this allowlist is the only thing that keeps
// GITHUB_TOKEN, AWS variables, SSH_AUTH_SOCK, DBUS_SESSION_BUS_ADDRESS, TMUX
// and termag's own variables away from the app.

import (
	"fmt"
	"sort"
	"strings"
)

// AllowedEnv is every name the app may receive. The agent sends the values;
// the launcher refuses a name outside this list rather than dropping it.
var AllowedEnv = map[string]bool{
	"PATH": true, "HOME": true, "LANG": true, "TERM": true, "TMPDIR": true,
	"NODE_ENV": true, "PORT": true,
	// Found in the prototype: npm writes its debug log under ~/.npm/_logs,
	// which is read-only, and prints a warning on every `npm run` without
	// this. The telemetry switches stop Next.js and Storybook writing their
	// opt-out state into ~/.config (refused) on first start.
	"npm_config_logs_dir": true, "npm_config_update_notifier": true,
	"NEXT_TELEMETRY_DISABLED": true, "STORYBOOK_DISABLE_TELEMETRY": true,
	// Vite and Storybook try to open a browser on the box otherwise.
	"BROWSER": true,
}

// FixedEnv is set for every app, by the launcher alone: not on AllowedEnv,
// so the agent can neither send nor override it.
var FixedEnv = []string{
	// pnpm 10+ checks the install before `pnpm run` (verifyDepsBeforeRun).
	// Its state file names the checkout's absolute paths, so the run's copy
	// always looks uninstalled, and the install it then starts fails on the
	// store's lock outside the sandbox: `pnpm run <script>` never ran the
	// script (webapp, pnpm 12.6).
	"PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false",
}

// BuildEnv validates the agent's KEY=VALUE list and returns it, with
// FixedEnv, sorted.
func BuildEnv(pairs []string) ([]string, error) {
	seen := map[string]bool{}
	out := make([]string, 0, len(pairs))
	for _, kv := range pairs {
		k, _, ok := strings.Cut(kv, "=")
		if !ok || k == "" {
			return nil, fmt.Errorf("bad --env %q", kv)
		}
		if !AllowedEnv[k] {
			return nil, fmt.Errorf("--env %s is not on the allowlist", k)
		}
		if seen[k] {
			return nil, fmt.Errorf("--env %s given twice", k)
		}
		seen[k] = true
		out = append(out, kv)
	}
	for _, k := range []string{"PATH", "HOME", "TMPDIR"} {
		if !seen[k] {
			return nil, fmt.Errorf("--env %s is required", k)
		}
	}
	out = append(out, FixedEnv...)
	sort.Strings(out)
	return out, nil
}
