---
project: termag
status: production
status_description: "Multi-user workspace orchestrator at https://secorp.net/termag. Runs paired tmux sessions per project, web terminals via xterm.js + WebSocket, Codex/Claude per-project agent choice, Slack + Discord integration. In active daily use as the harness for everything else under ~/termag/projects/."
last_updated: 2026-04-27
last_updated_by:
  - agent:claude-opus-4-7
  - human:secorp
  - agent:sweeper-claude-opus-4-7
wiki_schema_version: 1
---

# AGENTS.md — termag

## What This Is

A multi-user workspace manager for running AI coding agents in parallel. Each project gets a paired set of tmux sessions — an **agent** pane (Codex, Claude Code, or other agents) and a **ctrl** pane (regular terminal for sudo / interactive auth / things the agent can't run). The web UI renders both terminals side-by-side with xterm.js, shows real-time agent status (working/waiting/idle from Claude hooks + Codex app-server), and exposes per-project usage and a Slack `/t` command surface.

**Live:** `https://secorp.net/termag` — Google OAuth, multi-user (`ALLOWED_USERS` maps `email:unixuser`).

## Status

Production. Daily use as the harness for every other project under `~/termag/projects/`. Stable enough that the rest of the workspace's CLAUDE.md guidance assumes termag is running. Active: Codex + Claude provider selection per-project, Slack/Discord channels, usage dashboard.

## Domain Model

- **Project** — an addressable workspace. Has a name, a working directory, an `agent` workflow (the paired tmux sessions), persisted `agentProvider` (string id resolved through the provider registry), and a Slack channel `#proj-<name>` auto-created on creation.
- **Paired tmux sessions** — `secorp-<project>-agent` (where the AI runs) and `secorp-<project>-ctrl` (regular shell). The web UI streams both via PTY + WebSocket.
- **Provider registry** — `backend/src/providers/registry.ts` and `frontend/src/providers/registry.ts` define the set of supported agent providers (codex, claude, …) and their metadata: display name, launch command shape, status normalization rules, UI affordances. `agentProvider` is now a free-form string keyed into the registry rather than a Prisma enum, so adding a provider is a code change in two registry files (no migration). Each user also has a saved `defaultAgentProvider` for the create-project form.
- **Per-user agent process** — `agent/agent.js` runs as the unix user (via systemd user service + lingering). It owns tmux attach, node-pty, filesystem ops, and Codex-bridge lifecycle. The main server at `:3040` is one process; each user has their own agent talking to it via WebSocket with a bearer token. This separation keeps unix permissions clean.
- **Status events** — Claude Code hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`) and Codex app-server status updates POST to `:3040/termag/api/status`. Status drives the green/yellow/red indicators, the project-list transition flash (color-coded green/yellow/red by transition type — e.g. idle→working green, working→waiting yellow, anything→idle red), and the "hyperspace" animation that speeds up with activity. The `Notification` hook distinguishes `idle_prompt` (idle) from other notifications (waiting).
- **Working-time tracking** — derived from status transitions: time spent in `working` state is rolled up per-project for the usage dashboard. Served from `/termag/api/worktime`.
- **Status WebSocket** — `/termag/ws/status` pushes status events to anyone subscribed (the UI itself, plus opt-in consumers like `sound-garden`).

## Repository Layout

```
~/src/termag/                       (canonical; ~/termag/projects/termag is a symlink to here)
├── backend/                        Express + TS server, port 3040
│   ├── src/
│   │   ├── routes/                 REST: projects, status, usage, worktime, auth
│   │   ├── providers/registry.ts   Provider registry — adding a provider lives here
│   │   ├── services/               tmux, tmuxPoller, status, agent registry, usage tracking
│   │   └── middleware/auth.ts      Google OAuth gate + email→unixuser mapping
│   └── prisma/                     schema + migrations
├── frontend/                       React 18 + Vite, basename /termag
│   └── src/
│       ├── components/             Terminal (xterm.js), ProjectControl, UsageMini, Hyperspace
│       ├── providers/registry.ts   Mirror of backend provider registry — must stay in sync
│       ├── contexts/               AuthContext, ProjectContext
│       └── services/               REST + WebSocket clients
├── agent/                          Per-user agent (plain JS, no build step)
│   ├── agent.js                    main entry — WebSocket to backend, node-pty + tmux attach
│   ├── codex-status-bridge.js      Codex app-server status normalization
│   └── codex-status-normalizer.js
├── relay/                          Chrome tab-capture relay (runs on user's laptop)
├── deploy/                         systemd units, Apache snippet, claude-hooks.md, setup walkthrough
└── service-files/                  staged copies of systemd units
```

## Architecture

```
Browser ──https──▶ Apache (:443, /termag/*)
                    ├── /termag/ws/*    → ws://localhost:3040/termag/ws/*    (terminal streams + status push)
                    └── /termag/*       → http://localhost:3040/termag/*

Backend (single process, systemd "termag", root or service user, port 3040)
  ├── REST API     /termag/api/* (projects, status, usage, worktime, auth)
  ├── WebSocket    /termag/ws/terminal/<sessionId>  PTY stream
  │                /termag/ws/status                fan-out push
  │                /termag/ws/agent                 per-user agent connections
  ├── tmux poller  Periodically samples tmux session state as a fallback signal
  ├── Slack Bolt   Socket Mode (no public webhook needed)
  └── Postgres     prisma schema + sessions via connect-pg-simple

Per-user agent (systemd --user, runs as the unix user)
  ├── WebSocket → backend /termag/ws/agent (bearer token)
  ├── node-pty → tmux attach <session>
  └── Codex bridges (per Codex-backed agent session)

Claude Code hooks (in each user's ~/.claude/settings.json)
  └── curl POST → :3040/termag/api/status   (UserPromptSubmit, Pre/PostToolUse, Notification, Stop)
```

Apache modules required: `ssl`, `proxy`, `proxy_http`, `proxy_wstunnel`, `rewrite`, `headers`.

**Trade-off: single backend + per-user agents vs single multi-user backend** — chose split. The backend can run as root or a service user without inheriting any one user's filesystem permissions; tmux/PTY/filesystem ops happen as the actual user via the agent. Cost: every user must run their own systemd `--user` agent and `loginctl enable-linger`.

**Trade-off: Slack Socket Mode vs HTTPS webhooks** — chose Socket Mode. No public ingress for Slack; reuses the same outbound TCP that the backend already maintains. Same call as `claude-code-proxy-bot` and `reactji-image`.

**Trade-off: Codex bridge as a managed subprocess vs in-pane only** — chose managed. The agent process owns the bridge lifecycle so termag can normalize Codex's app-server status into the same `working/waiting/idle` shape as Claude Code hooks, without each user wiring it up.

**Trade-off: provider registry as code in two files vs a single shared package** — chose duplicated registries (`backend/src/providers/registry.ts` and `frontend/src/providers/registry.ts`). Adding a provider is a small symmetric edit in both; the alternative (a shared workspace package) buys deduplication at the cost of a build-graph complication this repo otherwise avoids.

## Data & Schema

`backend/prisma/schema.prisma`. Key models (not exhaustive):

| Model | Purpose |
|-------|---------|
| `User` | Google identity + mapped unix user. Holds `defaultAgentProvider` (string), agent token records, usage rollups. |
| `Project` | Name, working dir, `agentProvider` (string keyed into the provider registry, no longer an enum), Slack channel id, archived flag. |
| `AgentToken` | Bearer token for a per-user agent connection. Issued from the UI sidebar. |
| `StatusEvent` | Append-only log of `working/waiting/idle` events; backs the status WebSocket, the "hyperspace" activity score, the project-list transition flash, and worktime rollups. |
| `WorkTime` | Per-project rollup of time spent in `working` state, derived from `StatusEvent`. Powers `/termag/api/worktime`. |
| `UsageEvent` | Per-call API usage (tokens, cost) for the dashboard. |
| `session` | Managed by `connect-pg-simple`, NOT in `schema.prisma`. Created by the SQL block in `deploy/setup.md`. |

`agentProvider` migrated from a Prisma enum to a plain string in the `20260427000000_provider_string_and_worktime` migration. Existing values continue to work; new providers no longer require a schema change.

`prisma migrate dev` is fine here (the box is interactive); the rest of the workspace prefers `db push` because some boxes aren't.

## Configuration

`backend/.env` (gitignored). Key vars (see `.env.example` for the full list):

| Var | Notes |
|-----|-------|
| `DATABASE_URL` | Postgres |
| `SESSION_SECRET` | random hex |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth |
| `ALLOWED_USERS` | comma-separated `email:unixuser` pairs (the auth gate) |
| `SLACK_BOT_TOKEN` (`xoxb-`), `SLACK_APP_TOKEN` (`xapp-`), `SLACK_SIGNING_SECRET` | Slack Socket Mode |
| `CAPTURE_API_SECRET` | LTS relay shared secret (used by `claude-code-proxy-bot`) |
| `PORT` | `3040` |

Per-user agent: `~/.config/termag/agent.config.json` with `server_url` (`ws://localhost:3040/termag/ws/agent`) and `token` (created in the UI sidebar → Agent Tokens).

## Build, Run, Deploy

```bash
# build
cd backend && npm install && npm run build
cd ../frontend && npm install && npm run build

# run main server
sudo systemctl daemon-reload && sudo systemctl enable --now termag

# run per-user agent (as that user)
mkdir -p ~/.config/systemd/user
cp deploy/termag-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now termag-agent
sudo loginctl enable-linger <username>     # so it runs without an active login

# wire Claude Code hooks (per user)
# add the JSON block from deploy/claude-hooks.md to ~/.claude/settings.json
```

Apache snippet already in `secorp.conf`. See `deploy/setup.md` for the canonical first-time walkthrough; `deploy/claude-hooks.md` for the hook config.

## Observability & Maintenance

- `journalctl -u termag -f` — main server.
- `journalctl --user -u termag-agent -f` — per-user agent (run as the user).
- `tail -f /var/log/apache2/error.log` — proxy + WebSocket upgrade errors.
- Status events live in Postgres (`StatusEvent`) — usable for ad-hoc queries about agent activity.
- The agent process must be restarted whenever `agent/agent.js` changes (no hot reload).

## Integration Surfaces

**HTTP / WebSocket** (selected):

| Endpoint | Purpose |
|----------|---------|
| `GET /termag/api/projects` | List projects |
| `POST /termag/api/projects` | Create project (also creates tmux sessions + Slack channel) |
| `POST /termag/api/status` | Status update from Claude hooks / Codex bridge — primary write path |
| `GET /termag/api/usage/...` | Token + cost rollups for the dashboard |
| `GET /termag/api/worktime/...` | Working-time rollups (time spent in `working` state, derived from `StatusEvent`) |
| `WS /termag/ws/terminal/<sessionId>` | PTY stream (bidirectional) |
| `WS /termag/ws/status` | Status push fan-out — consumed by the UI and by `sound-garden` |
| `WS /termag/ws/agent` | Per-user agent connection (bearer-token auth) |

**Slack `/t` commands** (in any channel the bot is in; auto-routes by `#proj-<name>` channel):

| Command | Effect |
|---------|--------|
| `/t` | Capture + post the active agent terminal |
| `/t <text>` | Send text to the agent terminal, poll for output |
| `/t !<keys>` | Send keystrokes without Enter (e.g. `/t !2` for numbered prompts) |
| `/t ctrl [...]` | Same, against the ctrl terminal |
| `/t create <name>` | New project + tmux sessions + Slack channel |
| `/t switch <project>` | Switch active project |
| `/t projects`, `/t ls` | Listing helpers |

**LTS** — `claude-code-proxy-bot` runs an `:3100` LTS API for its mac-capture daemon. The Apache `/lts/` route in `secorp.conf` currently proxies to `:3040` (this server), not `:3100` — see [claude-code-proxy-bot](../claude-code-proxy-bot/AGENTS.md) Gotcha #3.

## Gotchas

1. **Per-user agent must be restarted on `agent/agent.js` changes** — no hot reload. Forgetting this leaves stale code running and is a common "why isn't my fix taking" debug detour.

2. **`loginctl enable-linger <user>` is mandatory** — without it, the per-user agent stops the moment the user logs out, which makes everything in the UI hang the next time termag tries to talk to that user's agent.

3. **`session` table is owned by `connect-pg-simple`, not Prisma** — don't add it to `schema.prisma`. The `CREATE TABLE` SQL is in `deploy/setup.md` and must be run once after creating the DB.

4. **Slack scopes are large** — the bot needs `app_mentions:read`, `chat:write`, `channels:manage`, `channels:read`, `commands`, `im:history`, `im:read`, `im:write`, `files:read`, `reactions:read`, `reactions:write`, `users:read`, `users:read.email`. Re-add any you remove and reinstall the app or `/t create` will silently fail to create channels.

5. **WebSocket upgrade ordering in Apache** — `/termag/ws/*` ProxyPass MUST come before the plain `/termag/*` ProxyPass in the vhost, otherwise socket upgrades fall through to plain HTTP and the terminal never connects.

6. **`ALLOWED_USERS` maps email→unixuser** — both columns matter. A typo in the unixuser half doesn't fail OAuth; it fails later when the per-user agent can't be reached because no such systemd user service is running.

7. **The `~/termag/projects/` dirs are symlinks** to `~/src/<project>/` for everything except agent-wiki itself. When writing tooling that walks projects (the agent-wiki indexer, the sweeper, etc.), `readlink -f` to get the canonical path before doing anything path-sensitive.

8. **Claude Code hooks fire `curl ... &` (background)** — the `&` is load-bearing. Without it, every tool use blocks on the localhost POST and feels visibly slower. Don't "clean up" the trailing `&` from `deploy/claude-hooks.md`.

9. **Codex bridge subprocess is owned by the per-user agent** — termag's main server doesn't manage it. If a Codex session looks dead, check the agent's logs (`journalctl --user -u termag-agent`), not the main server's.

10. **Provider registry lives in two files and must stay in sync** — `backend/src/providers/registry.ts` and `frontend/src/providers/registry.ts`. Adding a provider on one side only produces a project that the backend will accept but the UI can't render (or vice versa). There's no shared package; the symmetry is by hand.

11. **`agentProvider` is a string, not an enum** — Prisma will happily persist arbitrary garbage. The registry is the validation boundary; route handlers should reject providers not in the registry before writing.

## Related

**Other projects:**
- [agent-wiki](../agent-wiki/AGENTS.md) — this project's docs spec; consumes nothing from termag at runtime
- [sound-garden](../sound-garden/AGENTS.md) — subscribes to `/termag/ws/status` to turn agent state into ambient audio
- [claude-code-proxy-bot](../claude-code-proxy-bot/AGENTS.md) — different Slack bot; shares the box; LTS API on `:3100` (the `/lts/` route in Apache currently mis-points to `:3040`)
- [reactji-image](../reactji-image/AGENTS.md), [meeting-slack-app](../meeting-slack-app/AGENTS.md) — same Slack workspace; different shapes

**Topics:** none yet.

<!-- agent-wiki:backlinks-start -->
- [agent-wiki](../agent-wiki/AGENTS.md) — Status, Related
- [claude-code-proxy-bot](../claude-code-proxy-bot/AGENTS.md) — Related
- [sound-garden](../sound-garden/AGENTS.md) — Related
- [typing-lag](../typing-lag/AGENTS.md) — Related
<!-- agent-wiki:backlinks-end -->
