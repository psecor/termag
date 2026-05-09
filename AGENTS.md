---
project: termag
status: production
status_description: "Multi-user workspace orchestrator. Runs paired tmux sessions per project, web terminals via xterm.js + WebSocket, multi-provider agent choice (Codex, Claude, Mistral/vibe), Slack + Discord integration, project sharing with collaborators, two-tube thermometer UI tracking both agent working time and human activity (with 7d/30d human-activity charts in the usage overlay), and a pinned/recent-activity-sorted project list with a per-tile overflow menu."
last_updated: 2026-05-09
last_updated_by:
  - agent:claude-opus-4-6
  - agent:claude-opus-4-7
  - agent:sweeper-claude-opus-4-7
wiki_schema_version: 1
---

# AGENTS.md — termag

## What This Is

A multi-user workspace manager for running AI coding agents in parallel. Each project gets a paired set of tmux sessions — an **agent** pane (Codex, Claude Code, or other agents) and a **ctrl** pane (regular terminal for sudo / interactive auth / things the agent can't run). The web UI renders both terminals side-by-side with xterm.js, shows real-time agent status (working/waiting/idle from Claude hooks + Codex app-server), and exposes per-project usage and a Slack `/t` command surface.

Auth is Google OAuth with an `ALLOWED_USERS` allowlist mapping `email:unixuser`.

## Status

Production-ready. Provider registry covers Codex, Claude, and Mistral (vibe); per-project working-time and human-activity tracking feed a two-tube thermometer UI; project sharing lets owners invite collaborators with terminal access; new projects get seeded `AGENTS.md` and `CLAUDE.md`.

## Domain Model

- **Project** — an addressable workspace. Has a name, a working directory, an `agent` workflow (the paired tmux sessions), persisted `agentProvider` (string id resolved through the provider registry), and a Slack channel `#proj-<name>` auto-created on creation. New projects are seeded with `AGENTS.md` (from the agent-wiki initial template) and a `CLAUDE.md` stub. Projects also carry a `pinned` flag and a `lastActiveAt` timestamp that drive the project list ordering: pinned projects float to the top, then the rest sort by recent activity. Pin/unpin and other per-project actions live in an overflow menu on each project tile.
- **Paired tmux sessions** — `<unixuser>-<project>-agent` (where the AI runs) and `<unixuser>-<project>-ctrl` (regular shell). The web UI streams both via PTY + WebSocket.
- **Provider registry** — `backend/src/providers/registry.ts` and `frontend/src/providers/registry.ts` define the set of supported agent providers (codex, claude, mistral/vibe, …) and their metadata: display name, launch command shape, status normalization rules, **tmux poller config** (idle/working detection patterns per provider, since e.g. vibe has a persistent input box that breaks naive polling), **usage scanner source** (Codex JSONL, Claude logs, vibe `~/.vibe/logs/session/meta.json`), and UI affordances. `agentProvider` is a free-form string keyed into the registry rather than a Prisma enum, so adding a provider is a code change in two registry files (no migration). Each user also has a saved `defaultAgentProvider` for the create-project form.
- **Per-user agent process** — `agent/agent.js` runs as the unix user (via systemd user service + lingering). It owns tmux attach, node-pty, filesystem ops, and Codex-bridge lifecycle. The main server at `:3040` is one process; each user has their own agent talking to it via WebSocket with a bearer token. This separation keeps unix permissions clean.
- **Status events** — Claude Code hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`) and Codex app-server status updates POST to `:3040/termag/api/status`. For providers without a hook surface (vibe), the **tmux poller** in `backend/src/services/tmuxPoller.ts` samples pane content and infers state using provider-specific patterns. Status drives the green/yellow/red indicators, the project-list transition flash (15s, color-coded green/yellow/red by transition type — e.g. idle→working green, working→waiting yellow, anything→idle red), and the "hyperspace" animation that speeds up with activity. The `Notification` hook distinguishes `idle_prompt` (idle) from other notifications (waiting). Status events also bump `Project.lastActiveAt`, which feeds the recent-activity sort.
- **Context-token warnings** — the per-user agent scrapes provider-specific "context remaining" strings out of the agent pane and forwards them through the status pipeline as a separate signal alongside working/waiting/idle. The UI surfaces this on the project tile and inside the terminal chrome so a session that's about to run out of context gets a visible warning before it hard-fails.
- **Rate-limit detection** — same shape as context-token warnings: the per-user agent (`agent/agent.js`) watches the agent pane for provider-specific rate-limit / quota-exhausted messages and forwards a `rateLimited` signal through the status pipeline. The backend persists it on the project's status record and the UI surfaces it on the project tile and in `ProjectControl` so a stuck session is visually distinguishable from a merely-idle one.
- **Working-time tracking** — derived from status transitions: time spent in `working` state is rolled up per-project for the usage dashboard. Provider-specific poller sources ensure correct attribution. Served from `/termag/api/worktime`.
- **Human activity tracking** — `backend/src/services/humanActivity.ts` tracks human keystrokes/interactions per project, separate from agent working time. Powers the second tube of the two-tube thermometer in the UI (agent work vs. human work).
- **Project sharing** — owners can invite collaborators by email. Shared users get terminal access to the project's tmux sessions through the same per-user-agent path. Routes in `backend/src/routes/sharing.ts`.
- **Status WebSocket** — `/termag/ws/status` pushes status events to anyone subscribed (the UI itself, plus opt-in external consumers).

## Repository Layout

```
termag/
├── backend/                        Express + TS server, port 3040
│   ├── src/
│   │   ├── routes/                 REST: projects, status, usage, worktime, sharing, auth
│   │   ├── providers/registry.ts   Provider registry — adding a provider lives here
│   │   ├── services/               tmux, tmuxPoller, status, humanActivity, agent registry, usage tracking
│   │   └── middleware/auth.ts      Google OAuth gate + email→unixuser mapping
│   └── prisma/                     schema + migrations
├── frontend/                       React 18 + Vite, basename /termag
│   └── src/
│       ├── components/             Terminal (xterm.js), ProjectControl, UsageMini (two-tube thermometers + 7d/30d human-activity charts in the usage overlay), Hyperspace
│       ├── providers/registry.ts   Mirror of backend provider registry — must stay in sync
│       ├── contexts/               AuthContext, ProjectContext
│       └── services/               REST + WebSocket clients
├── agent/                          Per-user agent (plain JS, no build step)
│   ├── agent.js                    main entry — WebSocket to backend, node-pty + tmux attach
│   ├── codex-status-bridge.js      Codex app-server status normalization
│   ├── codex-status-normalizer.js
│   ├── agent.config.example.json   sample per-user agent config
│   └── initial-AGENTS.md           template seeded into new projects on creation
├── relay/                          Chrome tab-capture relay (runs on user's laptop)
└── deploy/                         systemd units, Apache snippet, claude-hooks.md, setup walkthrough
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

**Trade-off: Slack Socket Mode vs HTTPS webhooks** — chose Socket Mode. No public ingress for Slack; reuses the same outbound TCP that the backend already maintains.

**Trade-off: Codex bridge as a managed subprocess vs in-pane only** — chose managed. The agent process owns the bridge lifecycle so termag can normalize Codex's app-server status into the same `working/waiting/idle` shape as Claude Code hooks, without each user wiring it up.

**Trade-off: provider registry as code in two files vs a single shared package** — chose duplicated registries (`backend/src/providers/registry.ts` and `frontend/src/providers/registry.ts`). Adding a provider is a small symmetric edit in both; the alternative (a shared workspace package) buys deduplication at the cost of a build-graph complication this repo otherwise avoids.

## Data & Schema

`backend/prisma/schema.prisma`. Key models (not exhaustive):

| Model | Purpose |
|-------|---------|
| `User` | Google identity + mapped unix user. Holds `defaultAgentProvider` (string), agent token records, usage rollups. |
| `Project` | Name, working dir, `agentProvider` (string keyed into the provider registry, no longer an enum), Slack channel id, archived flag, owner, `pinned` flag and `lastActiveAt` timestamp (drive project-list ordering: pinned first, then recent activity). |
| `ProjectShare` | Collaborator grants on a project — `(projectId, userId)` with role. Backs the sharing routes; lets a non-owner reach the owner's tmux sessions through their own agent. |
| `AgentToken` | Bearer token for a per-user agent connection. Issued from the UI sidebar. |
| `StatusEvent` | Append-only log of `working/waiting/idle` events; backs the status WebSocket, the "hyperspace" activity score, the project-list transition flash, and worktime rollups. Status writes also bump `Project.lastActiveAt`. |
| `WorkTime` | Per-project rollup of time spent in `working` state, derived from `StatusEvent`. Powers `/termag/api/worktime`. |
| `HumanActivity` | Per-project rollup of human keystroke/interaction time, derived from terminal input events. Powers the human tube of the two-tube thermometer. |
| `UsageEvent` | Per-call API usage (tokens, cost) for the dashboard. Provider-specific scanners populate this (Codex JSONL, Claude logs, vibe `~/.vibe/logs/session/meta.json`). |
| `session` | Managed by `connect-pg-simple`, NOT in `schema.prisma`. Created by the SQL block in `deploy/setup.md`. |

`agentProvider` migrated from a Prisma enum to a plain string in the `20260427000000_provider_string_and_worktime` migration. Project sharing landed in `20260427100000_project_sharing`. `Project.pinned` and `Project.lastActiveAt` landed in the `20260503000000_add_project_pinned_and_lastActiveAt` migration. Existing values continue to work; new providers no longer require a schema change.

`prisma migrate dev` is fine here (this is an interactive box); on non-interactive deploy targets prefer `db push`.

## Configuration

`backend/.env` (gitignored). Key vars (see `.env.example` for the full list):

| Var | Notes |
|-----|-------|
| `DATABASE_URL` | Postgres |
| `SESSION_SECRET` | random hex |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth |
| `ALLOWED_USERS` | comma-separated `email:unixuser` pairs (the auth gate) |
| `SLACK_BOT_TOKEN` (`xoxb-`), `SLACK_APP_TOKEN` (`xapp-`), `SLACK_SIGNING_SECRET` | Slack Socket Mode |
| `CAPTURE_API_SECRET` | shared secret used by external pane-capture relays |
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

Apache snippet in `deploy/apache.conf`. See `deploy/setup.md` for the canonical first-time walkthrough; `deploy/claude-hooks.md` for the hook config.

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
| `GET /termag/api/projects` | List projects (own + shared) |
| `POST /termag/api/projects` | Create project (also creates tmux sessions, Slack channel, seeds AGENTS.md + CLAUDE.md) |
| `POST /termag/api/status` | Status update from Claude hooks / Codex bridge — primary write path |
| `GET /termag/api/usage/...` | Token + cost rollups for the dashboard (provider-specific scanners) |
| `GET /termag/api/worktime` | Working-time rollups by provider (agent + human), derived from `StatusEvent` and heartbeats; thermometers use an absolute 8h scale |
| `POST /termag/api/status/heartbeat` | Human activity heartbeat from the UI (fires every 30s while typing); 3-min decay banks to `work_time_entries` with `provider: "human"` |
| `POST /termag/api/projects/:id/invite` | Invite a collaborator by email |
| `GET /termag/api/invites` | List pending invites for the logged-in user |
| `POST /termag/api/invites/:id/accept` | Accept a project invite |
| `DELETE /termag/api/projects/:id/shares/:shareId` | Revoke a collaborator's access |
| `WS /termag/ws/terminal/<sessionId>` | PTY stream (bidirectional) |
| `WS /termag/ws/status` | Status push fan-out — consumed by the UI and any opt-in external listener |
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

## Gotchas

1. **Per-user agent must be restarted on `agent/agent.js` changes** — no hot reload. Forgetting this leaves stale code running and is a common "why isn't my fix taking" debug detour.

2. **`loginctl enable-linger <user>` is mandatory** — without it, the per-user agent stops the moment the user logs out, which makes everything in the UI hang the next time termag tries to talk to that user's agent.

3. **`session` table is owned by `connect-pg-simple`, not Prisma** — don't add it to `schema.prisma`. The `CREATE TABLE` SQL is in `deploy/setup.md` and must be run once after creating the DB.

4. **Slack scopes are large** — the bot needs `app_mentions:read`, `chat:write`, `channels:manage`, `channels:read`, `commands`, `im:history`, `im:read`, `im:write`, `files:read`, `reactions:read`, `reactions:write`, `users:read`, `users:read.email`. Re-add any you remove and reinstall the app or `/t create` will silently fail to create channels.

5. **WebSocket upgrade ordering in Apache** — `/termag/ws/*` ProxyPass MUST come before the plain `/termag/*` ProxyPass in the vhost, otherwise socket upgrades fall through to plain HTTP and the terminal never connects.

6. **`ALLOWED_USERS` maps email→unixuser** — both columns matter. A typo in the unixuser half doesn't fail OAuth; it fails later when the per-user agent can't be reached because no such systemd user service is running.

7. **Project working dirs may be symlinks** — when writing tooling that walks projects, `readlink -f` to get the canonical path before doing anything path-sensitive.

8. **Claude Code hooks fire `curl ... &` (background)** — the `&` is load-bearing. Without it, every tool use blocks on the localhost POST and feels visibly slower. Don't "clean up" the trailing `&` from `deploy/claude-hooks.md`.

9. **Codex bridge subprocess is owned by the per-user agent** — termag's main server doesn't manage it. If a Codex session looks dead, check the agent's logs (`journalctl --user -u termag-agent`), not the main server's.

10. **Provider registry lives in two files and must stay in sync** — `backend/src/providers/registry.ts` and `frontend/src/providers/registry.ts`. Adding a provider on one side only produces a project that the backend will accept but the UI can't render (or vice versa). There's no shared package; the symmetry is by hand.

11. **`agentProvider` is a string, not an enum** — Prisma will happily persist arbitrary garbage. The registry is the validation boundary; route handlers should reject providers not in the registry before writing.

12. **tmux poller patterns are provider-specific** — TUIs with a persistent input box (vibe/Mistral) look "working" to a naive idle/working detector forever. The registry's poller config has to match the actual TUI's render; if a new provider's working-time looks pinned at 100% or 0%, the regex in its registry entry is wrong before anything else.

13. **Working-time attribution is per-provider source** — Codex pulls from JSONL session files, Claude from hook events, vibe from `~/.vibe/logs/session/meta.json`. Mixing sources (e.g. counting a Claude project's hook events as if they were poller-derived) double-counts; each provider entry declares its single source of truth.

14. **Thermometers use an absolute 8h scale, not p50-relative** — when reading the UI, a half-full tube means ~4 hours of work that day, not "average for this project". This was a deliberate switch; don't "fix" it back to relative without thinking about what the tube means at a glance.

15. **Project sharing routes terminal access through the *owner's* per-user agent** — a collaborator's browser hits the backend, but the PTY lives in the owner's tmux. If a shared project's terminal won't connect, the owner's `termag-agent` is the thing to check, not the collaborator's.

16. **Context-token warnings are parsed from agent pane text, not a structured signal** — the per-user agent scans tmux pane content for provider-specific "context left" / token-budget strings and surfaces them via the status pipeline so the UI can flash a warning on the project tile. If a provider changes its wording, the warning silently stops appearing; the parsing lives in `agent/agent.js` and is the place to update.

17. **Rate-limit detection is also pane-text parsing** — same caveat as context warnings. The `rateLimited` flag is inferred from provider-specific quota/rate-limit phrases in the agent pane. If a provider rewords its rate-limit message, the project tile silently stops showing the rate-limit state; update the patterns in `agent/agent.js`.

18. **Slack `/t` executor strips `ANTHROPIC_API_KEY` from the spawned env** — `backend/src/slack/executor.ts` deliberately removes any inherited `ANTHROPIC_API_KEY` before spawning `claude`, so the subprocess uses the user's own auth (Claude Code login / subscription) instead of a stale workspace key. Don't "helpfully" add it back; doing so silently routes Slack-driven sessions onto the wrong account and burns the wrong quota.

19. **Project-list ordering is `pinned DESC, lastActiveAt DESC`** — `lastActiveAt` is bumped on status writes, not on every API touch, so a project you opened in the UI but haven't run the agent in won't float up. If recent-activity sort "isn't working," check that status events are actually arriving (Claude hooks installed, agent up) before suspecting the sort.

## Related

**Other projects:**
- [agent-wiki](https://github.com/psecor/agent-wiki) — the docs spec this project's `AGENTS.md` follows; consumes nothing from termag at runtime

**Topics:** none yet.
