# cli-go: the Go build of termag's CLI (prototype)

One static `termag` binary that runs the commands it has ported itself and hands every other
command to the Node CLI in `cli/`, unchanged. It's a strangler: the Node CLI stays the fallback
for anything not ported yet, so every consumer (termag-desktop, webapp's `termag-cli-ensure`,
the Claude hooks, the box agent, skills) keeps working from the first commit. Each command that
gets ported moves into the Go dispatch table. Nothing installs this binary yet. `cli/install.sh`
and the launcher still exec Node, and switching them over is a separate, reviewed change.

The plan, the parity matrix and the consumer contracts are in the termag space at
`plans/termag-cli-go-migration/inventory.md`.

## What runs where

| Go (ported) | Node (through the fallback) |
|---|---|
| `--help` and `help <cmd>` for all 72 commands, `--version`, every parse error | everything else |
| `login`, `logout`, `whoami` | `doctor`, which `login` runs as a child after signing in |
| `box list`, `project list` | the box lifecycle, `project create/rename/archive` |
| `space ls/get/put/url/rm/mv` | `space share/unshare/create/members/boxes/slack` |
| `space memory context/sync/ls/cat`, `space sync` | `space memory add/edit/rm/log/pane-claude` |
| `ask` (send, `--thread`, `--no-wait`, `--reply`, `--cancel`, `--inbox`, `--targets`, `--find`) | `ask --new-box` |
| `bug report` | `bug list/show/triage` |
| `events`, `forward` (protocol v2 and v1), `ssh`, `ssh-proxy`, `ssh-config`, `attach` | `handoff`, `automation`, `environment`, `preview`, `releases`, `webapp-*`, `update`, `tui` |

`internal/cli/run.go` lists the remaining ports as TODOs where their dispatch entries go.

The fallback execs `node "$TERMAG_CLI_CHECKOUT/cli/bin/termag.js" "$@"` with the same argv,
environment and terminal; the process becomes Node, so the exit code is Node's.

- **The checkout:** `TERMAG_CLI_CHECKOUT` (the launcher exports it), else the checkout the binary
  sits in (`<checkout>/cli-go/dist/termag`).
- **Node:** `TERMAG_CLI_NODE`, else `node` on `PATH`. The launcher pins the Node it was installed
  with, so a Go launcher should export `TERMAG_CLI_NODE` too, since under ssh's ProxyCommand,
  systemd or a non-login shell a version manager's `node` isn't on `PATH`.

A handler can also return `errFallback` before doing anything, which hands that one run to Node
(`ask --new-box`, the unported `space memory` subcommands).

## The launcher (not switched yet)

`cli/install.sh` writes a sh launcher, not a symlink, and three consumers read it: webapp's
`termag-cli-ensure` greps for `^# termag-cli-launcher` and reads `TERMAG_CLI_CHECKOUT='…'` with
`sed`, and `termag update` and `install.sh --check` rely on it. A Go launcher keeps all of that and
changes only what it execs:

```sh
#!/bin/sh
# termag-cli-launcher: written by '<CLI_DIR>/install.sh'. Update with `termag update`.
TERMAG_CLI_CHECKOUT='<checkout>'
TERMAG_CLI_BIN='<bin_dir>/termag'
TERMAG_CLI_NODE='<abs node>'
export TERMAG_CLI_CHECKOUT TERMAG_CLI_BIN TERMAG_CLI_NODE
exec "$TERMAG_CLI_CHECKOUT/cli-go/dist/termag" "$@"
```

`TERMAG_CLI_BIN` keeps naming the launcher, not the Go binary, because `termag update` reinstalls
into `dirname "$TERMAG_CLI_BIN"` (`cli/src/update.ts`).

## Build, test, generate

```sh
make build            # dist/termag, static (CGO_ENABLED=0), stamped with ./version.sh
make dist             # dist/termag-{darwin,linux}-{arm64,amd64}
make test vet         # go test ./... and go vet ./...
make generate         # regenerate internal/cli/spec_gen.go and testdata/ from the Node CLI (npm ci in cli/ first)
make check-generated  # the drift test alone, failing (not skipping) when node or cli/node_modules is missing
```

The command table (`internal/cli/spec_gen.go`), meaning every command's summary, usage, options,
details and argument limit, is generated from `cli/src/args.ts` by `tools/genspec.mjs`, so help
text and option rules can't drift from Node's. The same script writes the golden fixtures the tests
compare against: every command's `--help`, the Node parser's verdict on a list of command lines,
and the outputs of `normalizeHost`, `deviceNameFrom`, `table`, `formatDate`, `formatBytes` and
`redactSecrets`. `TestGeneratedFilesMatchTheNodeCLI` (`internal/cli/generated_test.go`) reruns the
script into a temporary directory and fails on any difference from the committed files, so plain
`go test ./...` catches a Node CLI change that skipped `make generate`. Without node or `npm ci` in
`cli/` it skips, and says so; `TERMAG_REQUIRE_GENSPEC=1` makes it fail instead.

### Version

`--version`, the `User-Agent` (`termag-cli/<v>`), usage reports and bug reports carry
`<major>.<minor>.<commits touching cli/ or cli-go/>+<sha8>[.dirty]`. That is the Node CLI's scheme
(`cli/buildVersion.mjs`) counted over both directories, so the number keeps growing: it's never
below the Node CLI's for the same commit, and a commit that only touches `cli-go/` still gets a
new one. `version.sh` prints it and `make build` stamps it with
`-ldflags -X github.com/example-org/termag/cli-go/internal/cli.Version=…`. An unstamped build
says `0.1.0+unknown`.

## Behaviour kept on purpose

- **Credentials:** `${XDG_CONFIG_HOME:-$HOME/.config}/termag/credentials.json`, on macOS too (never
  `os.UserConfigDir`). The format is the same: other hosts' entries and unknown fields keep their
  order, timestamps are `…T…:…:….000Z`, the directory is 0700 and the file 0600, replaced atomically.
  Hosts are keyed by `NormalizeHost`, which follows the WHATWG URL parser for the parts it keeps
  (lowercase host, no default port, IPv6 compressed, dot segments resolved, no trailing slash,
  `/termag` by default, `http` for loopback).
- **Errors:** `termag: <message>` on stderr, or with `--json` anywhere in argv one line
  `{"error":{"code","message"}}` on stderr and nothing on stdout. Exit codes are 0/1/2/3/4/5/6, and
  10–12 are reserved for `releases pr`.
- **JSON:** `JSON.stringify(v, null, 2)`, with key order coming from ordered structs or `*Object`
  and never from a Go map. Server objects pass through as they were sent.
- **HTTP:** redirects aren't followed (a 3xx is the edge asking for a browser sign-in), there's one
  refresh-and-retry on a 401, and a 15 s timeout covers the body.
- **Proxies, a deliberate change from Node:** `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (and their
  lowercase forms) are honoured by the API client, the S3 transfers, the usage sender and the
  WebSocket dials of `events` and `forward`. Loopback is never proxied. Node's built-in fetch ignores
  them (rollout decision, 2026-11-12).
- **SIGPIPE:** `termag … | head -1` and `| true` exit cleanly. A write after the reader goes away
  fails with EPIPE and is dropped, and the command carries on to its own exit code. The binary uses
  `signal.Notify` rather than `signal.Ignore` for this, because an ignored signal would stay
  ignored in the children it execs.
- **Usage reports:** one `POST /usage` per run, skipped with `TERMAG_TELEMETRY=0` or `DO_NOT_TRACK`.
  A run that made no request of its own (the hooks' `space memory context`) hands its report to a
  detached copy of this binary (`termag __usage-post`, with the request on stdin) and exits at once.

## Open questions for review

1. **Distribution:** should `install.sh` build the binary (`go build` when Go is on the machine) or
   download a prebuilt one (a CI artifact or a release)? The minimal box image has no Go.
2. **Rollout:** should the launcher switch all at once or behind a per-machine opt-in first (for
   example `TERMAG_CLI_GO=1`)? CI should also diff Go against Node for every ported command on
   each `cli/` change.
3. **Versioning:** is counting over `cli/ cli-go/` the right call, or should the minor be bumped
   when Go takes over?
4. ~~Proxy environment~~: decided 2026-11-12, honoured (above).
