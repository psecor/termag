# termag TUI

A terminal client for termag: the web sidebar's project list with live agent
status, a peek pane, and tmux attach — without a browser. This is **phase 0**: read-mostly,
with attach on a box or the orchestrator.

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
`GET /api/cli/v1/sessions` and capture. It cannot type into a session: the
CLI API has no send-keys until CLI sessions can be revoked, so attach instead
(`termag connect` once it exists, for a box other than this one). Signing out is
`termag logout`, or Settings → CLI sign-ins in the web UI. The TUI never opens
a WebSocket: a box's agent token is also a valid `/termag/ws/agent` credential,
and opening that path would evict the real agent.

`~/.config/termag/tui.json` holds settings only (`returnKey`, the remembered
selection). Box names aren't on the API yet, so boxes are labelled by instance
id; the one whose sessions exist on this host's tmux server is "this box".

## Keys

| Key | Action |
|---|---|
| `j` `k` `↑` `↓` `g` `G` PgUp PgDn | move |
| `enter` / `c` | attach the agent / ctrl session — local tmux only in this phase |
| `tab` | peek pane: agent ↔ ctrl |
| `w` / `W` | next / previous session that is `waiting` |
| `s` | off for now: shows a hint to attach instead (the CLI API has no send-keys) |
| `/` | filter by project, owner or workstream; Esc clears |
| `R` | refresh now |
| `?` `q` | help, quit |

Inside tmux, attach is `tmux switch-client`; the TUI binds `prefix+T` (config
`returnKey`, `null` to disable) to switch back to its own session. Outside tmux
it runs `tmux attach` in the foreground; detach returns to the lobby.

A row flashes for 15 s when its status changes and the terminal bell rings when
a session enters `waiting`.

## Development

```
npm test        # vitest: model (grouping, aggregation, flash), config, API client
TERMAG_URL=… TERMAG_TOKEN=… npm run dev     # tsx, no build step
```
