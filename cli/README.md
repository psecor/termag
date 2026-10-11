# termag CLI

`termag` manages termag boxes and projects from a terminal, for people and for
agents: sign-in and listing, box and project lifecycle, `ssh`, `attach` and
`ssh-config` over SSM, and `doctor` (milestones 1 to 4).

## Install and update

The CLI is installed from a termag clone; there is no npm package, Homebrew tap
or release. You need Node.js 20 or newer (`node --version`) and git.

```bash
git clone git@github.com:example-org/termag.git ~/src/termag
cd ~/src/termag
make install-cli          # or: sh cli/install.sh
termag login
```

`make install-cli` builds `cli/` (it has no runtime dependencies; `npm ci` only
fetches the compiler) and writes a small `termag` launcher into `~/.local/bin`,
or into `/usr/local/bin` when `~/.local/bin` is not on your `PATH` and
`/usr/local/bin` is, and you can write to it.
If the directory it picks is not on `PATH` it prints the line to add to your
shell's rc file. `make install-cli BIN_DIR=<dir>` (or `cli/install.sh --bin-dir
<dir>`) puts it somewhere else. It refuses to replace a `termag` it did not
write unless you pass `--force`.

The launcher runs the CLI from the clone, with the Node you installed it with,
or with `node` on `PATH` if that one is later removed. So:

- **To update**, run `termag update`. It runs `git pull --ff-only` in the clone
  the launcher points at, then the installer again. It pulls whatever branch the
  clone is on and never switches branches; when that isn't `main` it prints a
  one-line warning naming the branch first, and it refuses a detached HEAD.
  If you have built the TUI it rebuilds that too (see below); if you never have,
  it leaves it alone. `termag update --no-pull` only rebuilds, for a clone
  you've already moved yourself (a pull, a branch switch). Running
  `make install-cli` again rebuilds the CLI the same way.
- **Re-running is cheap and safe**: with nothing changed it does nothing. It runs
  `npm ci` only when `package-lock.json` changed and the compiler only when the
  sources did. A build that fails leaves the previous one in place.
- **To uninstall**, delete the launcher (`rm "$(command -v termag)"`) and, if you
  like, the clone.

`cli/install.sh --check` reports whether the build or the launcher is out of
date (exit 1) without changing anything.

### The TUI (`termag tui`)

The terminal UI is a separate build, because it needs Node.js 22 or newer and
has runtime dependencies. Build it once in the same clone:

```bash
make install-tui          # or: sh tui/install.sh
termag tui
```

It checks for Node 22 and says so if it finds an older one, runs `npm ci` and
builds `tui/`. Like `install-cli` it is idempotent: re-run it after a pull and it
rebuilds only what changed (`--check` reports without building). Once built,
`termag update` rebuilds it after the CLI, with the Node the CLI runs on; when
that Node is older than 22 the update still succeeds and prints how to reinstall
the CLI on a newer one, and the old TUI build stays as it was. If `termag tui`
finds no build it prints the exact `make -C <clone> install-tui` command for the
clone its launcher points at. `termag tui` runs on the CLI's own Node, so
install the CLI with Node 22 too.

**On a box** it is already installed: the image build runs the same installer
from `~/src/termag`, and `termag-reconcile` re-runs it at every boot and at every
run of the box's update service (`termag-box-update`, which the orchestrator
starts once the `box-auto-update-enabled` flag is on for the box's owner and
the box is behind; it also pulls `main`), so a box picks up a merged CLI
change on its own; after a
`git -C ~/src/termag pull` of your own, `termag update --no-pull` rebuilds it
now. On a box the CLI uses the box's own credentials, so it needs no
`termag login`.

For working on the CLI itself:

```bash
cd cli && npm ci && npm run build
node bin/termag.js box list
npm test
```

## Commands

| Command | What it does |
| --- | --- |
| `termag login [--device <name>]` | Opens the browser for the normal sign-in, then stores a device token. Needs a person at a terminal. |
| `termag logout` | Revokes this device's token and forgets it. |
| `termag whoami` | The signed-in user, the orchestrator, and which credential is in use. |
| `termag doctor [--yes]` | Checks this machine's setup and offers to fix what is missing. `login` runs it afterwards. |
| `termag box list` | Your boxes: name, state, whether the agent is connected, and their projects. |
| `termag project list` | Your projects as `<box>/<project>`, with agent and status. |
| `termag box create <name> [--wait] [--timeout <s>] [--if-not-exists]` | Creates an EC2 box. `--wait` reports progress on stderr until it is running with its agent connected (default limit 20 minutes, exit 5 past it). |
| `termag box start <box> [--wait] [--timeout <s>]` | Starts a stopped box, or resumes a hibernated one; its projects' sessions come back on their own. A running box is left alone. |
| `termag box stop <box>` | Stops a box, keeping its disk and projects. A stopped or hibernated box is left alone. |
| `termag box rm <box> [--yes]` | Terminates a box and archives its projects, after asking. Not allowed with a box's own credentials. |
| `termag project create <box>/<name> --agent <agent> [--if-not-exists]` | Creates a project on a box with that agent. |
| `termag project rename <box>/<project> <new-name>` | Renames a project; it stays on its box. |
| `termag project archive <box>/<project> [--yes]` | Archives a project, after asking. |
| `termag ssh <box>[/<project>] [<ssh options>] [-- <cmd>]` | A shell in the box's home or the project's directory, or `<cmd>` run there. ssh options pass through: `-N -L 3000:localhost:3000`. |
| `termag attach <box>/<project> [--ctrl]` | Attaches this terminal to the project's agent tmux session, or its ctrl shell. |
| `termag ssh-config [--install]` | Prints, or adds to `~/.ssh/config`, one `Host termag-*` entry, so `ssh termag-<box>`, scp, rsync and Remote-SSH work. |
| `termag tui [ls [filter]]` | The terminal UI ([`tui/`](../tui)), signed in with this CLI's credential. `ls` prints the lobby once. Needs Node 22 and `make install-tui`. |
| `termag update [--no-pull]` | Pull the clone this CLI was installed from (its current branch, with a warning off `main`) and reinstall it, and the TUI if it was built. |

Box and project names may contain only letters, digits, `-` and `_`. A box
named before that rule can still be addressed by its id (`termag box list
--json`). `--if-not-exists` returns the existing box or project instead of
failing. `rm` and `archive` ask first at a terminal; with no terminal attached
they need `--yes`.

Global flags: `--json`, `--yes`, `--host <url>` (or `TERMAG_URL`), `--help`, `--version`.
Exit codes: 0 ok, 1 failed, 2 usage error, 3 not found, 4 auth needed, 5 timeout.
Errors go to stderr, as JSON when `--json` is set.

## Doctor

`termag doctor` checks, in order:

- **Login:** the sign-in for this orchestrator is valid.
- **SSH key:** `~/.ssh/id_ed25519.pub` (or `id_ecdsa` / `id_rsa`) is registered, so termag installs it on your boxes. You add a key in the web UI (Settings, SSH keys); doctor prints the link. The CLI can't add one: a key opens a shell on every box, so like typing into a session it stays web-only until CLI sign-ins can be revoked.
- **GitHub:** the orchestrator holds your `gh auth token`.
- **GitHub SSO:** that token is SSO-authorized for `example-org` and `example-labs`.
- **AWS profile:** `[profile termag-boxes]` is in `~/.aws/config` (or `AWS_CONFIG_FILE`). The fix writes the same `[sso-session]` block as the first `termag ssh` (see "Connecting to a box").
- **SSM plugin:** `session-manager-plugin` is installed.
- **AWS SSO:** the session is valid.
- **SSH config:** the `Host termag-*` entry from `termag ssh-config --install` is present.
- **Claude:** whether your boxes get Claude through termag.

Each check is `ok`, `warn` or `fail`, with a fix. The exit code is 1 only
when a check fails. At a terminal, doctor asks once per fix it can make:

- generate a key with `ssh-keygen` when there is none (then add it in the web UI);
- store the gh token;
- add the profile;
- run `aws sso login`;
- `brew install` the plugin on macOS.

`--yes` makes those fixes without asking. With no terminal, or with `--json`,
it only reports. The gh token goes only to the orchestrator, which stores it
encrypted, and is never printed. On a box with its own credentials, the
laptop-only checks are skipped. A box's token can't change your GitHub token.

`src/doctor.test.ts` covers it with stand-in `gh`, `aws`,
`session-manager-plugin` and `ssh-keygen` in temporary homes, and
`scripts/e2e/cli-doctor.test.sh` runs it against the local stack.

## Which orchestrator and which credential

The orchestrator is `--host`, else `TERMAG_URL`, else (on a box) the box's own
orchestrator from its agent config, else `https://app.termag.example.com/termag`.
A bare `localhost:3040` means `http://localhost:3040/termag`.

The credential is the device token from `termag login` for that orchestrator,
stored in `~/.config/termag/credentials.json` (mode 0600). On a box, if there is
no device token, the CLI uses the box's agent token from
`~/src/termag/agent/agent.config.json`, so no login is needed there. The CLI
only calls `/termag/api/cli/v1`, never `/ws/agent`. `termag tui` hands the
same choice to the TUI as `TERMAG_URL` and `TERMAG_TOKEN`; for a device sign-in
that is a freshly refreshed access token, plus `TERMAG_REFRESH_TOKEN` and
`TERMAG_TOKEN_EXPIRES_AT` so the TUI can renew it.

## Sign-in

`termag login` listens on `127.0.0.1:<random port>` and opens
`/termag/auth/cli/authorize` with a PKCE challenge. That page is behind the
normal browser sign-in (a browser that isn't signed in yet is sent through it
and back) and asks you to approve the device. Approving redirects
to the loopback with a one-time code, which the CLI trades for a token. The
token is never in a URL. A sign-in lapses after 7 days without use and after 30
days regardless. Sign a device out with `termag logout` or from the web UI
(Settings, CLI sign-ins).

The device token is a refresh token: the CLI sends it only in the body of
`POST /api/cli/v1/token` to get an access token, a JWT valid for an hour, and
sends that as the bearer. The orchestrator's ALB lets `/termag/api/cli/*`
through without Okta only with an access token it can verify, so the CLI works
from any network; the orchestrator still checks the device sign-in on every
request.

With no terminal attached, `login` never opens a browser: it exits 4 so an
agent can ask its human.

## Connecting to a box

`termag ssh` is the laptop route to a box: ssh with an
`aws ssm start-session` ProxyCommand on the `TermagSSH` document (port 22 only)
with the `termag-boxes` profile, in the box's region. Your public key
gets onto your boxes from the SSH-keys settings. ssh logs in as the box's unix
user and files the host key under the instance id.

Before connecting it checks for the AWS CLI, `session-manager-plugin`, the
profile and a live SSO session. At a terminal it runs
`aws sso login --profile termag-boxes` itself when there is no session
or it has expired; with no terminal it exits 4 with that command instead. With
no terminal ssh also gets `BatchMode=yes`, so it never prompts.

If `~/.aws/config` (or `AWS_CONFIG_FILE`) has no `termag-boxes` profile,
the first connection writes one between `# >>> termag aws-config >>>` markers
at the end of the file, in the `[sso-session]` form:

```ini
[sso-session termag]
sso_start_url = https://your-org.awsapps.com/start/
sso_region = us-east-1
sso_registration_scopes = sso:account:access

[profile termag-boxes]
sso_session = termag
sso_account_id = 123456789012
sso_role_name = TermagUser
region = us-east-2
```

That form gets a refresh token, so the AWS CLI renews the profile's access
token by itself and one browser sign-in lasts the whole access-portal session
(an Identity Center setting, 8 hours by default). The legacy form, with
`sso_start_url` in the profile, can't refresh: its sign-in ends with its one
access token. It needs AWS CLI 2.9 or later, which the check enforces
before writing. A profile of your own by that name is left alone; if it is in
the legacy form, the CLI says so when it signs you in. Later connections only
rewrite what is between the markers, and only when it differs. If something
else (`dev/bin/update-aws-config`, say) later adds its own `termag-boxes`
profile or `[sso-session termag]` to the same file, the CLI removes its block on
the next connection: the AWS CLI refuses a config with a repeated section, and
the other profile reaches the same account and role.

- termag flags go before `<box>`; everything after it goes to ssh. One `<cmd>`
  argument is a shell command line, as with ssh (`-- 'make test | tail'`);
  several are words that arrive intact (`-- claude -p "fix the test"`).
- `<box>/<project>` runs in the project's directory, which the orchestrator
  reports. Remote commands run in your login shell non-interactively, so they
  see only the `PATH` that `~/.zshenv` sets, not `~/.zshrc`.
- `TERMAG_AWS_PROFILE` and `TERMAG_SSM_DOCUMENT` override the profile and the
  document. A profile named by `TERMAG_AWS_PROFILE` is yours: the CLI never
  writes it.

`termag ssh-config --install` puts its entry between
`# >>> termag ssh-config >>>` markers at the top of `~/.ssh/config` and touches
nothing outside them. Re-running it replaces the entry in place, or changes
nothing if it's current. A symlinked config is edited where it lives, and the
previous file is kept as `config.termag-backup`. The entry's ProxyCommand is
`termag ssh-proxy %h %p`, so plain ssh gets the same checks; it renews an SSO
session only when stderr is a terminal, so an editor's Remote-SSH gets a
one-line reason rather than a hidden prompt.

## Tests

`npm test` runs vitest. `src/cli.test.ts` and `src/lifecycle.test.ts` drive
every command end to end against an in-process fake orchestrator with a
temporary `HOME`; `src/tui.test.ts` covers how `termag tui` finds and starts the TUI.
`src/connect/connect.test.ts` drives the connect commands the same way, with
stand-in `aws`, `ssh` and `session-manager-plugin` binaries on `PATH`, and
`src/connect/sshConfig.test.ts` and `src/connect/awsConfig.test.ts` rewrite ssh
and AWS configs in temporary homes.
`src/update.test.ts` covers what `termag update` runs, and `sh install.test.sh`
runs the installer against a copy of `cli/` with a clean `HOME` (it needs
network for `npm ci`). `scripts/e2e/cli.test.sh` runs the commands against a real local stack, and
`scripts/e2e/cli-connect.test.sh` connects with real ssh to it.
