# termag TUI

A terminal client for termag: the web sidebar's project list with live agent
status, a peek pane, and attach — local tmux when the session is on this host,
streamed through the orchestrator when it is on another box — without a
browser.

It runs as `termag tui`, a subcommand of the termag CLI ([`cli/`](../cli)):

```
make install-cli                   # from the repo root; Node 22+ for the TUI
make install-tui                   # tui/install.sh: npm ci + build, safe to re-run
termag login                       # on a laptop; a box needs no sign-in
termag tui                         # lobby
termag tui ls                      # one-shot listing (also a good smoke test)
```

## Credentials

The TUI has none of its own. `termag tui` picks the orchestrator and the
credential the way every `termag` command does (`--host`, `TERMAG_URL`, the
box's agent config, the production default; a `termag login` device token
wins over the box's agent token) and starts `bin/termag-tui.js` with
`TERMAG_URL` + `TERMAG_TOKEN`. For a device sign-in the token is an hour-long
access token and `termag tui` adds `TERMAG_REFRESH_TOKEN` and
`TERMAG_TOKEN_EXPIRES_AT`, which the TUI uses to renew it before it lapses.
Started any other way, the TUI needs `TERMAG_URL` and `TERMAG_TOKEN`. It
deletes both tokens from its environment once read.

Every call goes to the CLI's bearer-only API: `GET /api/cli/v1/lobby`,
`GET /api/cli/v1/sessions`, `GET /api/cli/v1/prs` (the PR pills; a device
sign-in only, so a box's TUI shows none until `termag login`), capture, and `POST /api/cli/v1/heartbeat` while you
type in a remote attach. Its two WebSockets are that API's too —
`/api/cli/v1/ws/status` for live status and `/api/cli/v1/ws/terminal` for
remote attach — with the bearer in the `Authorization` header, never in the
URL. It cannot type into a session over HTTP: the CLI API has no send-keys,
so attach instead (`H` hands an agent off, which the server does with its own
fixed lines). Signing out is
`termag logout`, or Settings → CLI sign-ins in the web UI. The TUI never opens
`/termag/ws/agent`: a box's agent token is a valid credential there, and
connecting would evict the real agent.

`~/.config/termag/tui.json` holds settings only: `returnKey`, `prefix`,
`notify`, and the remembered selection. Box names aren't on the API yet, so
boxes are labelled by instance id; the one whose sessions exist on this host's
tmux server is "this box".

## Keys

| Key | Action |
|---|---|
| `j` `k` `↑` `↓` `g` `G` PgUp PgDn | move |
| `enter` / `c` | attach the agent / ctrl session: local tmux here, else remote (below) |
| `tab` | peek pane: agent ↔ ctrl |
| `w` / `W` | next / previous session that is `waiting` |
| `o` | show the row's top PR link (its pill: yellow yours, red failing, green ready) |
| `s` | off for now: shows a hint to attach instead (the CLI API has no send-keys) |
| `/` | filter by project, owner or workstream; Esc clears |
| `R` | refresh now |
| `?` `q` | help, quit |

## Attach

**Local** (the session is on this host's tmux server, and the project is on
this box): inside tmux, attach is `tmux switch-client`; the TUI binds
`prefix+T` (config `returnKey`, `null` to disable) to switch back to its own
session. Outside tmux it runs `tmux attach` in the foreground; detach returns to
the lobby.

**Remote** (anything else, including every shared project): the TUI hands your
terminal to the session through the orchestrator's terminal socket and the
box's agent, the same stream the browser's terminal uses. tmux on the box
renders everything; no emulation happens locally. One chord, prefix `C-\`
(config `prefix`: `"C-]"`, `"C-a"`, or a single character):

| Chord | Action |
|---|---|
| `C-\` `d` | detach, back to the lobby |
| `C-\` `tab` | flip between the agent and ctrl session of the same workstream |
| `C-\` `n` / `p` | next / previous project in lobby order |
| `C-\` `C-\` | send a literal `C-\` |
| `C-\` `?` | reminder |

The socket is retried on the browser's backoff (0, .5, 1, 2, 4, 8, 15, 30 s)
when the box agent drops; a refused credential or a session you cannot reach
ends the attach with the reason. Like a second browser tab, an attached TUI
shares the tmux window size with other viewers (`window-size largest`).

## Live status and notifications

Status arrives over `/api/cli/v1/ws/status` as it changes (the header says
`push`); when the socket is down the 2.5 s poll carries the lobby (`poll`). A
row flashes for 15 s when its status changes. When a session enters `waiting`
the terminal bell rings and, unless `notify` is `false`, the TUI emits a
desktop notification as OSC 777 and OSC 9 — WezTerm, kitty (with
`notify_on_cmd_finish`-style support enabled), foot and iTerm2 show it, other
terminals ignore it. Inside tmux the sequence is wrapped in a DCS passthrough,
which needs `set -g allow-passthrough on` in your tmux (3.3+).

## Development

```
npm test        # vitest: model, config, API client, sockets, prefix chord, notifications
TERMAG_URL=… TERMAG_TOKEN=… npm run dev     # tsx, no build step
```
