# termag CLI

`termag` manages termag boxes and projects from a terminal, for people and for
agents: sign-in and listing, box and project lifecycle, `ssh`, `attach` and
`ssh-config` over SSM, `forward` through the orchestrator, and `doctor`
(milestones 1 to 4).

## Install and update

The CLI is installed from a termag clone; there is no npm package, Homebrew tap
or release. You need Node.js 20 or newer (`node --version`) and git.

**Before you first sign in:** confirm you can open your deployment's web app
in the browser you will use for CLI approval. Installing the CLI or running
`termag login` does not grant access; your deployment's own access process
does.

```bash
git clone git@github.com:example-org/termag.git ~/src/termag
cd ~/src/termag
make install-cli          # or: sh cli/install.sh
termag login
```

`make install-cli` builds `cli/` (its one runtime dependency is `ws`, for
`termag forward` and `termag events`; `npm ci` fetches it, the type checker and
the bundler) and writes a small `termag` launcher into `~/.local/bin`,
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
  `npm ci` only when `package-lock.json` changed and the build only when the
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
rebuilds only what changed (`--check` reports without building). After the first build,
`termag update` rebuilds it after the CLI, with the Node the CLI runs on; when
that Node is older than 22 the update still succeeds and prints how to reinstall
the CLI on a newer one, and the old TUI build stays as it was. If `termag tui`
finds no build it prints the exact `make -C <clone> install-tui` command for the
clone its launcher points at. `termag tui` runs on the CLI's own Node, so
install the CLI with Node 22 too.

**On a box** it is already installed: the image build runs the same installer
from `~/src/termag`, and `termag-reconcile` re-runs it at every boot and at every
run of the box's update service (`termag-box-update`, which the orchestrator
starts when the `box-auto-update-enabled` flag is on for the box's owner and
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

`npm run build` type-checks with `tsc --noEmit`, then `build.mjs` bundles
`src/` with esbuild into `dist/main.js`, so a run loads one file instead of one
per module (about 20 ms faster). `src/events/socket.ts` and
`src/forward/forwarder.ts` need `ws` and are loaded with `import()`. They stay
in their own files in `dist/`, so only `events` and `forward` load them. Tests run on the TypeScript sources and don't need
a build.

## Commands

| Command | What it does |
| --- | --- |
| `termag login [--device <name>]` | Opens the browser for the normal sign-in, then stores a device token. Needs a person at a terminal. |
| `termag logout` | Revokes this device's token and forgets it. |
| `termag whoami` | The signed-in user, the orchestrator, and which credential is in use. |
| `termag doctor [--yes]` | Checks this machine's setup and offers to fix what is missing. `login` runs it afterwards. |
| `termag box list` | Your boxes: name, state, size (with the EC2 type it got; the type alone for a box with no size, or one sized by its repository's `.termag/environment.json` requirements), the disk it was made with (`DISK`), whether the agent is connected, and their projects. |
| `termag project list` | Your projects as `<box>/<project>`, with agent and status. |
| `termag box create <name> [--size small\|medium\|large] [--disk <GB>] [--wait] [--timeout <s>] [--if-not-exists] [--for-ask] [--minimal]`| Creates an EC2 box, at `--size` (small 2 vCPU / 8 GB, medium 4 / 16, large 8 / 32) or else your default size, once box sizes are on for you ([docs/box-provisioning.md](../docs/box-provisioning.md#box-sizes-backendsrcservicesboxsizets)) (`--for-ask`, deprecated for `termag ask --new-box`: makes it for an ask). `--disk` is its root disk, a whole number of GB from 50 to 300, else 120 ([Disk size](../docs/box-provisioning.md#disk-size-backendsrcservicesboxdisksizets)); any other disk than 120 launches a new box rather than taking a ready one from the warm pool. What of a repository's `.termag/environment.json` the orchestrator left out prints as `termag: warning: …`. `--wait` reports progress on stderr until it is running with its agent connected (default limit 20 minutes, exit 5 past it). `--minimal` launches the lean `Component=box-min` image instead of the full bake — the box contract only, bootstrapped by you; its disk defaults to `BOX_MINIMAL_ROOT_VOLUME_GB` (60) when neither `--disk` nor a repo file asks, and it never takes a warm-pool box. |
| `termag events [--json]` | The state of your boxes and agent sessions, then one line per change, until Ctrl-C. `--json` prints each as a JSON object on its own line. See [Events](#events). |
| `termag box start <box> [--wait] [--timeout <s>]` | Starts a stopped box, or resumes a hibernated one; its projects' sessions come back on their own. A running box is left alone. With `--wait`, a box still stopping or hibernating is started once it has; the wait for it to park and the wait for it to run each get 10 minutes unless `--timeout`, and a timeout exits 5, and running it again carries on. |
| `termag box stop <box>` | Stops a box, keeping its disk and projects. A stopped or hibernated box is left alone. |
| `termag box keep <box>` | Keeps a running box up: restarts its idle clock, as using it would, so auto-park waits another full limit. Needs your own sign-in, not a box credential. |
| `termag box rename <box> <new-name>` | Renames a box (alias `box mv`); its projects stay on it as `<new-name>/<project>`, and `ssh termag-<new-name>` reaches it. Re-run `termag ssh-config --install` if your ssh config has an entry for the old name. Behind the `box-rename-enabled` flag. |
| `termag box resize <box> <small\|medium\|large> [--force] [--wait] [--timeout <s>] [--yes]` | Resizes a box (sizes only, never an instance type): it stops for two to three minutes and anything running on it stops; a stopped or hibernated box is resized and left stopped ([docs/box-provisioning.md](../docs/box-provisioning.md#resizing-a-box-backendsrcservicesboxresizets)). Asks first (`--yes` without a terminal). A box with a turn running is refused with what blocks it; at a terminal it asks again, otherwise pass `--force`. `--wait` prints each phase on stderr until it is done (default limit 30 minutes). A box's own credentials may resize only a box they created. |
| `termag box rm <box> [--yes]` | Terminates a box and archives its projects, after asking. With a box's own credentials, only a box that box created. |
| `termag project create <box>/<name> --agent <agent> [--from <template\|github-url\|box/project>] [--new-box [--size small\|medium\|large] [--disk <GB>] [--timeout <s>]] [--if-not-exists] [--for-ask]` | Creates a project on a box with that agent. `--for-ask` (deprecated: `termag ask --new-box` makes the box and project for an ask and asks in one command) records that the project (and, with `--new-box`, the box) is made for an ask; an existing project `--if-not-exists` finds is left as it was. `--from` starts it as a clone of a template (`webapp`, `research`) or any GitHub repository, as the web form's "Start from" does, or of the repository another of your projects (`<box>/<project>`) is a checkout of. `--new-box` creates the box `<box>` and the project with it, then waits for the box, like the web form's "a new box…". The new box is `--size`, else the repository's `.termag/environment.json` `resources` ([docs/box-provisioning.md](../docs/box-provisioning.md#a-repositorys-environment-termagenvironmentjson)), else your default, with a disk of `--disk` GB (as `box create`). `--size` and `--disk` go with `--new-box` only. |
| `termag project rename <box>/<project> <new-name>` | Renames a project; it stays on its box. |
| `termag project archive <box>/<project> [--yes]` | Archives a project, after asking. |
| `termag ssh <box>[/<project>] [<ssh options>] [-- <cmd>]` | A shell in the box's home or the project's directory, or `<cmd>` run there. ssh options pass through: `-N -L 3000:localhost:3000`. |
| `termag forward <box> <port>[:<local>]…` | Forwards each `<port>` on the box to `localhost:<local>` (default: the same port) through the orchestrator, with no SSM or ssh, until Ctrl-C, then prints the totals. Listens on `127.0.0.1` and `::1` only, and local ports start at 1024. Each connection is its own WebSocket to `127.0.0.1:<port>` on the box, with a fresh access token, renewed over it while it is open; the listeners stay up through failed connections and deploys, with one notice per wave of failures. It asks the orchestrator first, and where the native forward isn't available (an older orchestrator, the `box-port-forward-enabled` flag off, an outdated box agent) it prints the `termag ssh <box> -N -L …` that does the same. Needs your own sign-in, not a box credential. |
| `termag attach <box>/<project> [--ctrl]` | Attaches this terminal to the project's agent tmux session, or its ctrl shell. |
| `termag ssh-config [--install] [--wake]` | Prints, or adds to `~/.ssh/config`, one `Host termag-*` entry, so `ssh termag-<box>`, scp, rsync and Remote-SSH work. A box whose agent runs as another unix user (a claimed warm box runs as `termag`) gets its own `User` line. Each project also gets `termag-<box>.<project>`, which attaches to its agent's tmux session, and `termag-<box>.<project>.ctrl` for its ctrl shell, so any ssh client reaches them in one word; a project whose name ssh_config can't carry is left out with a note. Re-run it after adding a box or a project. With `--wake`, the entry's ProxyCommand is `termag ssh-proxy --wake`: connecting to your stopped or hibernated box starts it first (one still stopping or hibernating once it has), as `termag box start --wait` does, with progress on stderr and exit 5 after `--timeout` (default 600 s per wait). It is off by default because an editor that reconnects on its own would then keep a parked box up. |
 |
| `termag ask --new-box [--size small\|medium\|large] [--disk <GB>] [--from <box/project\|template\|github-url>]... <box>/<project>[:<repo>] <prompt\|-> [--title <text>] [--no-wait] [--timeout <s>]` | Asks on a box of its own: makes `<box>` and `<project>` for this ask when they are not there yet (an existing one is used as it is; a stopped box with the project on it is left for the ask to wake), waits for the box, then asks as below. `--from` once per repository the task needs: none is an empty project, one a project of it, two or more a multi-repo project of exactly those, asked in `:<repo>`, else the first `--from`'s checkout; a multi-repo project that is already there is asked as it is, with no `--from` (`:<repo>`, else its first repository). Each extra repository costs clone time and can raise the box size. The box is sized like any (`--size`, else the repositories' `.termag/environment.json`, the largest, else your default; its disk `--disk`, else their `diskGiB`, else 120), is stopped when idle and never hibernated, and the thread records that its box was made for it; the simple UI shows only its asks, under the session that sent them. `--timeout` covers the wait for the box too. Not with `--thread` or `@<workstream>`. |
| `termag ask <box>/<project>[@<workstream>][:<repo>] <prompt\|-> [--title <text>] [--thread <id>] [--no-wait] [--timeout <s>]` | Asks another project's agent; a multi-repo project one repository at a time, `:<repo>` naming it: it runs on that box in a sandboxed clone of its committed code (a box your box created for it only gives it its own machine; the sandbox is the same), and the reply prints fenced as `<untrusted-reply>`, with a draft PR for any commits and the thread id for a follow-up. Waits by default, one 50 s long poll after another with no overall limit unless `--timeout` (exit 5), and rides out a deploy: a 502/503/504, a dropped connection or a stalled poll is retried with backoff for up to 10 minutes. Replies are never stored: only a poll waiting when the turn finishes gets one, and otherwise it is dropped. A failed or canceled run, or a reply that was dropped, exits 1. The ask says which session sent it (a chat turn's `TERMAG_PROJECT_ID`/`TERMAG_WORKSTREAM`, else the tmux pane's session), so termag nests the thread under that session. `--title` names the thread, which is what termag calls its chat: a short, specific name, at most 60 characters, e.g. `--title "Members-only file composer (#765)"`. Nothing is taken from the prompt: an untitled thread shows as `ask-<thread id>`, and a new one asked without `--title` gets a one-line tip on stderr. A follow-up's `--title` names or renames the thread, and the sidebar shows the new name at once. `--no-wait` returns the ids at once; `--reply <message>` waits again on a working ask (status only once it has finished); `--cancel <message>` cancels a submitted or working ask and stops its run (the asker or the target project's owner); `--inbox` lists the last day's asks with what became of each reply (`delivered`, `dropped`, `none`) and of each turn's commits (`pushed`, `none`, `refused`, `failed`); `--targets` lists every project workstream you may ask, with its description and whether it can take an ask now (`--json`: A2A AgentCards). The CLI picks the message id, so the `POST` that starts an ask is retried through a deploy too without starting a second turn. An ask to your own parked box (stopped, hibernated, or on its way) starts it and runs once it is up, within 15 minutes; the orchestrator holds it, so it runs even if the CLI stops. A `--thread` follow-up while the thread's turn still works goes into that turn on a box that can take it: the earlier message ends `superseded`, its wait keeps going and gets the same final reply (`termag: answered together with follow-up <message>` on stderr), and the reply answers the follow-up. A follow-up the running turn can't take is queued as the thread's next turn, and stderr says so (Steering a working ask). A target that can't take a run (a box offline that isn't yours to start, agent too old) answers `rejected` with the reason at once and exits 1; for your own parked box on an orchestrator from before that, the CLI starts the box and asks again. States are A2A's (`submitted`, `working`, `completed`, `failed`, `canceled`, plus `rejected`, which is never stored, and termag's `superseded`, shown as `COMPLETED`), and `--json` prints each message as an A2A Task. |
| `termag handoff <box>/<project>[@<workstream>] [--mode clear\|compact\|restart] [--agent <agent>] [--note <text>] [--wait [--timeout <s>]] [--yes]` | Hands the agent off, after asking: when its turn ends it writes a handoff, then its context is cleared (the default) or compacted in place, or the pane restarts, on `--agent` if given (which implies restart), and the next agent starts on the handoff. The orchestrator does it all; `--wait` follows it to the end on stderr and exits 1 if it fails or is aborted; if one is already under way for that agent, `--wait` follows that one instead. Your own projects only, behind the `agent-handoff-enabled` flag. A box's own credentials reach only that box's projects; `termag login` for the rest. |
| `termag automation list [<box>\|<box>/<name>]` | Your automations (and those shared with you): `<box>/<name>`, id, schedule, state (`enabled`, `paused`, `paused: <why>`), next run, last run and space folder (`<space>:<folder>/`). See [Automations](#automations). |
| `termag automation create <box>/<name> <schedule> [--from <github-url\|template\|box/project>] [--tier full\|read] [--max-minutes <n>] [--no-pr] [--wake-box] [--space <name>] [--paused] [--preview] <prompt\|->` | Creates an automation on a box: a project of its own whose prompt (`-` reads it from stdin) a fresh agent runs on the schedule. `--space` puts its files in a space (see [Automations](#automations)). `--preview` prints the normalised schedule and the next runs and creates nothing (exit 2 if create would refuse it). |
| `termag automation show <automation> [--runs <n>]` | Its schedule, state, next three runs, tier, repository, space folder, prompt, web link, and the last runs (default 10) with trigger, state, duration and result (PR, summary or changes). |
| `termag automation edit <automation> [<schedule>] [--prompt <text\|->] [--name <new-name>] [--tier …] [--max-minutes <n>] [--pr\|--no-pr] [--wake-box\|--no-wake-box] [--space <name>\|--no-space]` | Changes what it was given; a change clears a pause and restarts the clock from now. `--name` renames its project. `--space` attaches it or moves it to another space (the old space's files stay), `--no-space` detaches it. |
| `termag automation pause <automation>` / `resume <automation>` | The web UI's Enabled switch. Paused, nothing runs on schedule (`run` still does); resumed, it runs from the next occurrence. |
| `termag automation run <automation>` | Run now: a manual run starts (or waits for its box), and prints the run id. |
| `termag automation stop <automation> <run>` | Stops a live run (`failed: stopped by its owner`). |
| `termag automation rm <automation> [--yes]` | Deletes the automation, after asking: its project is archived, the run history stays. |
| `termag bug report --title <title> [--severity low\|medium\|high] [--area <area>] [--command <command>] [--error-file <path>] [--agent <agent>] [--model <model>] - < body.md` | Reports a termag bug: a termag command or feature that behaved wrongly. The body is Markdown on stdin. Attaches the CLI version, the coding agent, its version and model (from the environment, or `--agent` / `--model`) and the session's project and workstream; the orchestrator adds the box and its agent. Secret-shaped strings are replaced with `[redacted: …]` before sending. Prints the report's id. At most 20 an hour per box. Write-only: no command reads reports back; admins triage them, duplicates included, at `/admin/bugs`. |
| `termag tui [ls [filter]]` | The terminal UI ([`tui/`](../tui)), signed in with this CLI's credential. `ls` prints the lobby once. Needs Node 22 and `make install-tui`. |
| `termag update [--no-pull]` | Pull the clone this CLI was installed from (its current branch, with a warning off `main`) and reinstall it, and the TUI if it was built. |

A shell or `attach` checks that the box knows your terminal's `TERM`. Ghostty
(`xterm-ghostty`) and kitty (`xterm-kitty`), for example, have no terminfo
entry on a box's Ubuntu, and tmux refuses to attach without one. Before the
session starts, `termag ssh` and `termag attach` copy the entry from this
machine (`infocmp -x`) into the box user's `~/.terminfo` (`tic -x`), on the
same connection, and only where the box lacks it. With no `infocmp` here, or
no entry to copy, the session runs under `TERM=xterm-256color` instead, with a
one-line notice, and so does a plain `termag ssh <box>` whose ssh
configuration sets a `RemoteCommand`. A `TERM` from ncurses-base (`xterm*`,
`screen*`, `tmux*`, …), a remote command, `-N`, `-T` and `RequestTTY=no` are
left as they were.

Box and project names may contain only letters, digits, `-` and `_`. A box
named before that rule can still be addressed by its id (`termag box list
--json`). `--if-not-exists` returns the existing box or project instead of
failing. `rm` and `archive` ask first at a terminal; with no terminal attached
they need `--yes`.

A box and its first project in one command, as the web UI's New project
dialog does with "a new box…":

```bash
termag project create mybox/termag-fix --new-box --agent claude --from termag
```

It creates `mybox` and, while it provisions, the project on it, then reports
progress on stderr until the box is running with its agent connected (default
limit 20 minutes, `--timeout`, exit 5 past it). The orchestrator holds the
project and sets it up when the box's agent connects, so a timeout or Ctrl-C
loses nothing. The project's agent pane runs the clone before the agent
starts, so you watch it with `termag attach`. Add `--if-not-exists` to make it
safe to re-run after a timeout: it picks up the existing box and project
instead of failing. If the project is refused, the box stays and the error
prints the `termag project create` line that retries the project alone; if the
box fails to launch, the project's Retry in the web UI launches a new one.

Global flags: `--json`, `--yes`, `--host <url>` (or `TERMAG_URL`), `--help`, `--version`.
Exit codes: 0 ok, 1 failed, 2 usage error, 3 not found, 4 auth needed, 5 timeout, 6 a space file changed since you read it.
Errors go to stderr, as JSON when `--json` is set.

## Events

`termag events` is for a script that acts when a box stops or starts, or when
an agent starts to wait or comes to rest. It prints the current state first,
one event per box and then one per agent session the orchestrator has a
status for. After that it prints one event per change until Ctrl-C, which
exits 0. With `--json`, each event is a JSON object on its own line of stdout.
Notices about the connection go to stderr.

```bash
termag events --json | jq -c 'select(.type == "box" and .previous != null)'
```

```json
{"type":"box","at":"2026-10-28T14:05:00.000Z","box":{"id":"cmb1…","name":"devbox"},"state":"stopping","previous":"running","agentConnected":true}
{"type":"session","at":"2026-10-28T14:06:10.000Z","session":"alice-web-agent","box":{"id":"cmb1…","name":"devbox"},"status":"idle","previous":"working","stoppedAt":"2026-10-28T14:06:09.812Z"}
```

Every event has `type`, `at` (when this CLI saw the change, ISO 8601) and
`previous` (`null` the first time the stream reports that box or session).
An optional field is left out when it is unknown, never `null`.

| `type: "box"` | |
| --- | --- |
| `box` | `id` and `name`. |
| `state` | As `termag box list` shows it: `running`, `stopping`, `stopped`, `starting`, `hibernating`, `hibernated`, `provisioning`, `awaiting-agent`, `failed` or `unknown`. `terminated` once the box leaves your box list. |
| `agentConnected` | Whether the box's agent was connected at the change. A started box turns `running` when its agent connects. |
| `error` | Why it failed. Only with `state` `failed`. |

| `type: "session"` | |
| --- | --- |
| `session` | The tmux session, named as in `termag project list --json` (`sessions`). |
| `box` | `id` and `name` of the box it runs on. Left out for a session on the orchestrator's own host. `name` is left out for a box that is not in your box list, such as the box of a project shared with you. |
| `status` | `working`, `waiting`, `idle` or `not_running`. |
| `waitingReason` | `approval`, `user_input` or `unknown`. Only with `status` `waiting`. |
| `stoppedAt` | When the session last came to rest, from `working` or `waiting` to `idle` or `not_running`. Optional: an orchestrator that does not send it, or a session that has never come to rest, has none. |

A box event comes when the box's `state` changes. The CLI reads the box list
every 5 s while a box is going up or down, every 30 s otherwise, and at once
when the orchestrator says the list changed, which it does when someone asks
for a start, a stop, a new box, a rename or a terminate. A session event comes
when its `status` or `waitingReason` changes. Context-token, rate-limit and
review updates are not events. The per-user agent clears a stale `waiting`,
so a wait can end without anyone answering it.

The statuses come from the TUI's socket, `/api/cli/v1/ws/status`. When the
socket drops, as it does in a deploy, on a network change or while the laptop
sleeps, the CLI dials again at once and then up to 30 s apart. It also drops
a socket that has sent nothing for 60 s and dials again. Once it is back, the
orchestrator's replay of every status and a read of the box list report what
changed in the meantime. A change that was undone in the meantime is not
reported. A lapsed access token is renewed
without a notice. A revoked or expired sign-in ends the stream with exit 4.
On a box, with no `termag login`, it runs with the box's own credentials.

## Automations

`termag automation` manages the web UI's scheduled automations:
a project whose
prompt a fresh agent runs on a schedule, each run its own workstream and branch.
`<automation>` is `<box>/<name>` or its id (`termag automation list`).

```bash
termag automation create mybox/pr-babysit --every 15m --from https://github.com/example/repo - < prompt.md
termag automation show mybox/pr-babysit
termag automation run mybox/pr-babysit
```

A schedule is one of `--every <15m|30m|1h|2h|…|1d|1w>` (intervals that divide an
hour or a day; `1d` and `1w` take `--at`), `--at <HH:MM> [--weekdays]` (daily, or
Monday to Friday), or `--cron "<m h dom mon dow>"` (5 fields, or `@hourly`,
`@daily`, …), in `--tz <IANA zone>` (default: this machine's). The orchestrator
answers exactly as it does the web UI: the 15-minute minimum interval (the
`automation-limits` flag can change it), the other limits and
`automations-enabled` (403) are checked there, with the same messages. Only the
owner can change, run, stop or delete an automation; someone it is shared with
can list and show it.

**In a space.** `--space <name>` on create or edit attaches the automation to a
space you can write to (editor or owner), and its files live in
`<space>:.termag/automations/<automation id>/`
(decision 13). The folder is fixed
by the automation's id: there is nothing to choose, and a rename never moves it.
It is not space memory: agents in the space don't load it.

```bash
termag automation create mybox/digest --every 1d --at 07:00 --space team-notes - < prompt.md
termag automation show mybox/digest                  # Space: team-notes:.termag/automations/<id>/
termag automation edit mybox/digest --space ops      # the files in team-notes stay there
termag automation edit mybox/digest --no-space       # detach; its files stay in the space
```

The folder's `README.md`, `state.json` and run logs (`runs/<run>.md`) are only
written while `automation-space-folder-enabled` is on for the owner. With it
off, only the notes file (`memory/MEMORY.md`) is mirrored. A space you can't
write to, one that is read-only, or spaces being off for you are refused with
what to do about it; a space you aren't a member of is "not found" (exit 3).

On a box, with no `termag login`, the box's own credentials manage only the
automations on that box, and create them only there (another box's is "not
found"). Sign in with `termag login` to manage the rest.

## Space files and their versions

`termag space get` reports the version it downloaded (`etag`, `versionId` in
`--json`) and remembers it, per space and path, in
`~/.termag/spaces/.versions/<space>.json`. `space memory ls`, `space memory cat`
and the memory sync remember what they show too. A later write says which
version it replaces:

| | |
| --- | --- |
| `termag space put <file> space:path` | Replaces only the version you read last, if you read one. A path this client never read is written as before, unconditionally |
| `… --if-match <etag>` | Replaces only that version |
| `… --if-new` | Only if the file doesn't exist yet |
| `… --force` | Unconditionally |
| `termag space put <dir> space:dir/ -r` | Each file checks its own version; the rest are written, the refused ones are named |
| `termag space mv` / `space rm` (one file) | Only if it is still the version you read; `--force` skips the check. A folder's files aren't checked |

A refused write exits **6**, writes nothing and says why:
`team:a.md changed since you read it (yours "…", now "…" by bob@example.com (box-2) at …)`.
Get it again, merge, and put again, or `--force` to overwrite.

## Sharing a space file

`termag space url <space:path>` prints a file's browser link, which opens for
the space's members. `termag space share <space:path>` shares that one file
read-only with everyone signed in to termag, so the same link opens for them
too; `termag space unshare <space:path>` makes it private again. Both take
`--json`, and `termag space ls` marks a shared file `(shared)`.

```sh
termag space put shot.png team:pr-123/shot.png
termag space share team:pr-123/shot.png
termag space url team:pr-123/shot.png    # link this in the PR
```

You need editor or owner on a space that isn't read-only, and the file must
exist; otherwise it is refused (exit 1, or 3 for a missing file) with the
reason. On **a box** (its own credentials, with no `termag login`) the box
shares with its owner's role, any file a person could: the share is recorded
as the box owner's, and the audit names the box. Share only what is meant to
be seen, never logs or files that might hold secrets.

## Doctor

`termag doctor` checks, in order:

- **Login:** the sign-in for this orchestrator is valid.
- **SSH key:** `~/.ssh/id_ed25519.pub` (or `id_ecdsa` / `id_rsa`) is registered, so termag installs it on your boxes. You add a key in the web UI (Settings, SSH keys); doctor prints the link. The CLI can't add one: a key opens a shell on every box, so it stays web-only. It was held back until CLI sign-ins could be revoked; they can be now, and allowing it is a separate decision not made yet.
- **GitHub:** the orchestrator holds your `gh auth token`.
- **GitHub SSO:** that token is SSO-authorized for `example-org` and `example-team`.
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

Each run also sends the orchestrator a usage report, which it records as the
`cli.command` product event: the command's name (`box list`, never its
arguments), how it ended and how long it took, the CLI's version, and whether
a person or Claude Code ran it.
It goes with the same credential, and only when there is one. It is skipped
when it fails. A command that made no request of its own, such as the
`space memory context` hooks, leaves its report to a short-lived background
process and exits without waiting for it. `TERMAG_TELEMETRY=0` or
`DO_NOT_TRACK=1` turns it off.

## Sign-in

`termag login` listens on `127.0.0.1:<random port>` and opens
`/termag/auth/cli/authorize` with a PKCE challenge. That page is behind the
normal browser sign-in (a browser that isn't signed in yet is sent through it
and back) and asks you to approve the device. Approving redirects
to the loopback with a one-time code, which the CLI trades for a token. The
token is never in a URL. An account termag doesn't list (`ALLOWED_USERS`) is
sent back to the loopback with `error=not_allowed` instead, and `login` stops
at once saying the account has no access yet: an account your identity
provider let in, unlike the 401 below. A sign-in lapses after 7 days without use and after 30
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

### Browser stops at `401 Authorization Required`

Behind an ALB with OIDC sign-in, a 401 at `/oauth2/idpresponse` comes from the
load balancer's identity-provider callback, before the CLI approval page. The CLI cannot
read that browser response; it waits for its loopback callback and eventually
times out with exit 5.

Check the `error` and `error_description` parameters in the browser's address:

- `error=access_denied` with `error_description=User is not assigned to the
  client application.` means the identity provider has not assigned your
  account to the app; ask whoever runs your deployment. Repeated logins or
  clearing cookies cannot grant it.
- A 401 without that description does not establish an assignment problem.
  Close stale termag login tabs and open the web app URL above directly rather
  than refreshing `/oauth2/idpresponse`. If it still fails, report only the
  error text and time, not the full callback URL, which may contain sign-in
  codes and state.

After web sign-in works, cancel any running `termag login` with Ctrl-C, then run it
again and approve its new link.

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
one-line reason rather than a hidden prompt. Without `--wake` it refuses a box
that isn't running, before it touches AWS.
The project hosts set `HostName termag-<box>`, so the same ProxyCommand reaches
the box (`%h` is the host name, not the alias), plus `RequestTTY yes` and a
`RemoteCommand` that attaches to the session the orchestrator names. ssh keeps
the first value it finds, so they sit above `Host termag-*`. They carry a remote
command, so use `termag-<box>` itself for scp, rsync and Remote-SSH.

## Tests

`npm test` runs vitest. `src/cli.test.ts` and `src/lifecycle.test.ts` drive
every command end to end against an in-process fake orchestrator with a
temporary `HOME`; `src/tui.test.ts` covers how `termag tui` finds and starts the TUI.
`src/connect/connect.test.ts` drives the connect commands the same way, with
stand-in `aws`, `ssh` and `session-manager-plugin` binaries on `PATH`, and
`src/connect/sshConfig.test.ts` and `src/connect/awsConfig.test.ts` rewrite ssh
and AWS configs in temporary homes.
`src/forward/forward.test.ts` drives `termag forward` and its library against a
fake forward server (`src/test/fakeForward.ts`) on the fake orchestrator: the
probe's refusals, both loopback families, backpressure each way, half-close,
retries and Ctrl-C.
`src/update.test.ts` covers what `termag update` runs, and `sh install.test.sh`
runs the installer against a copy of `cli/` with a clean `HOME` (it needs
network for `npm ci`). `scripts/e2e/cli.test.sh` runs the commands against a real local stack, and
`scripts/e2e/cli-connect.test.sh` connects with real ssh to it.
