# MetaTerm MCP server

The tool surface that lets Claude see (and, with confirmation, drive) every
tmux session the user may reach: own projects on every box, plus shared
projects. It runs in two places:

- **Boxes.** It is registered at user scope in `~/.claude.json`, so every
  Claude session on the box has the read tools. `deploy/termag-reconcile`
  installs the registration, the launcher `deploy/termag-metaterm-mcp`, the
  read-tool approvals and the `metaterm` skill (`deploy/claude-skills/`). It
  authenticates with the box's own `tmag_` token from the agent config.
- **Orchestrator.** The pinned MetaTerm project. `backend/src/services/metaterm.ts`
  seeds its `.mcp.json` (Claude Code auto-loads it from cwd) with `TERMAG_URL`,
  pointing at a root-owned copy of this file.

`mcp-server.mjs` is a dependency-free MCP-over-stdio server. It is a thin HTTP
client: each tool is one call to the termag backend with a Bearer agent token,
and the **backend** enforces access
(`backend/src/services/sessionAccess.ts`) and routes to the owning per-user agent.
It never talks to tmux itself, except to learn its own session name for the
self-target guard, and never opens `/termag/ws/agent`.

Tools: `list_sessions`, `capture_pane`, `search_sessions`, `session_status`,
`activity_ledger` and `latest_briefing` are pre-approved. The last two read the
daily briefing's routes (`GET /api/briefings/ledger`, `GET /api/briefings/latest`).
`send_keys` prompts for approval every time; that prompt is the confirm gate.

Agent spawn: `spawn_agent` starts a new agent on a
brief in a new workstream or project. It is never pre-approved, and the
backend gates it behind the `agent-spawn-enabled` flag and limits.
`METATERM_SPAWN=on|off` decides for a session, then
`METATERM_SPAWN_DEFAULT` (pi's registration sets `off`), else it is on.
`list_spawns`, `report_back` and `spawn_budget` (limits, usage, box load and
hints) touch only the caller's own spawn records
and are pre-approved on boxes. All four send the caller's own tmux session, and
`spawn_agent` also sends its `git rev-parse HEAD` as the default base.
`send_keys` is only listed when it is switched on. Highest precedence first:

- `METATERM_SEND_KEYS=on|off`, for a session.
- `.claude/metaterm.json` `{"sendKeys": true|false}`, in the cwd or a parent up
  to `$HOME`, for a project.
- `METATERM_SEND_KEYS_DEFAULT`, set by the registration: `off` on boxes, `on`
  on the orchestrator.
- With none of these, it is on.

`send_keys` refuses to type into the session its own Claude is running in.

Env:

- `TERMAG_URL`: the backend base URL. If unset, it is derived from the agent
  config's `termag_url`, else `http://localhost:3040/termag`.
- `TERMAG_TOKEN` / `TERMAG_AGENT_CONFIG`: the token, or the config to read it
  from. The config search order is that of `deploy/termag-status`.

The URL must reach the backend without a browser sign-in. Behind an ALB with
Okta, `/termag/api/sessions` and `/termag/api/projects/*/sessions/*` need an
OIDC bypass for the token's source, or the server reports
`→ 302 redirect to <idp>`. A laptop has no such path: run the server on a box
over SSH (`ssh <box> 'exec $HOME/.local/bin/termag-metaterm-mcp'` as the MCP
command) instead of copying a box token off it.

Tests: `node --test metaterm/*.test.mjs`. Smoke test without Claude:

```
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node metaterm/mcp-server.mjs
```

`capture_pane` returns plain text by default. Pass `styled: true` to keep ANSI
styling (`tmux capture-pane -e`). That is how a reader tells Claude Code's
dimmed ghost-text suggestions on the prompt line (`ESC[2m … ESC[22m`) from text
the user actually typed. The owner's agent must be new enough to honour the
flag; the reply header says `styled=false` when it wasn't.

`send_keys` text reaches tmux byte-for-byte (the agent spawns `tmux` with an
argv array, never a shell string), so apostrophes, `$`, backticks and quotes
in a prompt arrive as typed. Text beginning with `-` is fine too (`--`).
