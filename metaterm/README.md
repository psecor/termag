# MetaTerm MCP server

The tool surface for a user's **MetaTerm** project — a pinned Claude "control
tower" on the orchestrator that can see (and, with confirmation, drive) every
tmux session the user may reach (own projects on every box + shared projects).

`mcp-server.mjs` is a dependency-free MCP-over-stdio server. It is a thin HTTP
client: each tool is one call to the termag backend as the user (Bearer agent
token from `~/.termag/agent.config.json`), and the **backend** enforces access
(`backend/src/services/sessionAccess.ts`) and routes to the owning per-user agent.
It never talks to tmux itself and never opens `/termag/ws/agent`.

Tools: `list_sessions`, `capture_pane`, `session_status` (pre-approved) and
`send_keys` (prompts for approval every time — that prompt is the confirm gate).

Seeded into a MetaTerm project dir by `backend/src/services/metaterm.ts` via
`.mcp.json` (Claude Code auto-loads it from cwd). Env: `TERMAG_URL`
(default `http://localhost:3040/termag`), `TERMAG_TOKEN` / `TERMAG_AGENT_CONFIG`.

Smoke test without Claude:
```
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node metaterm/mcp-server.mjs
```
