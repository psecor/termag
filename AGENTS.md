---
project: termag
status: production
status_description: "Multi-user workspace orchestrator. Runs paired tmux sessions per project, web terminals via xterm.js + WebSocket, multi-provider agent choice (Codex, Claude, Mistral/vibe, Devin), Slack + Discord integration, project sharing with collaborators, two-tube thermometer UI tracking agent working time and human activity, pinned/recent-activity-sorted project list, on-demand EC2 box provisioning via Packer AMI + Terraform module ("Add box" button) with projects routed by `Instance`, per-project git-worktree workstreams (every project starts with `main`), and visit/flow-speed telemetry (ProjectVisit + WarpSample) surfaced in the usage overlay."
last_updated: 2026-06-01
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

Production-ready. Provider registry covers Codex, Claude, Mistral (vibe), and Devin; per-project working-time and human-activity tracking feed a two-tube thermometer UI; project sharing lets owners invite collaborators with terminal access; new projects get seeded `AGENTS.md` and `CLAUDE.md`. The orchestrator can now provision additional EC2 "boxes" on demand (Packer-baked AMI + Terraform module, surfaced as an "Add box" button) and route projects to a specific `Instance` via `Project.instanceId`. Every project carries a `main` workstream backed by a git worktree, with CRUD routes for additional workstreams. Visit + flow-speed telemetry (`ProjectVisit` for context switches, `WarpSample` for per-minute hyperspace-speed rollups) feeds new sections in the UsageMini overlay.

## Domain Model

- **Project** — an addressable workspace. Has a name, a working directory, an `agent` workflow (the paired tmux sessions), persisted `agentProvider` (string id resolved through the provider registry), and a Slack channel `#proj-<name>` auto-created on creation. New projects are seeded with `AGENTS.md` (from the agent-wiki initial template) and a `CLAUDE.md` stub. Projects also carry a `pinned` flag and a `lastActiveAt` timestamp that drive the project list ordering: pinned projects float to the top, then the rest sort by recent activity. Pin/unpin and other per-project actions live in an overflow menu on each project tile. Each project is bound to an `Instance` (box) via `Project.instanceId`; routing decisions key off that field.
- **Paired tmux sessions** — `<unixuser>-<project>-agent` (where the AI runs) and `<unixuser>-<project>-ctrl` (regular shell). The web UI streams both via PTY + WebSocket. Tmux helpers and the agent runtime are workstream-aware: every project gets a `main` workstream, and additional workstreams are realized as git worktrees with their own paired tmux sessions.
- **Workstream** — a named parallel line of work inside a project, backed by a git worktree. Phase-1 invariant: every project has a `main` workstream auto-created on project creation; additional workstreams are managed through `backend/src/routes/workstreams.ts` and corresponding agent RPCs in `backend/src/services/workstreams.ts`. The tmux session naming threads the workstream id through so two workstreams on the same project don't collide.
- **Instance ("box")** — a termag-running host. The orchestrator can provision additional boxes on AWS via the Packer AMI (`packer/`) + Terraform module (`terraform/box/`), triggered from the UI's "Add box" button. `Project.instanceId` and `AgentToken.instanceId` key off the `Instance` model so projects and per-user agent tokens are dual-keyed by host. Provisioning lives in `backend/src/services/boxProvisioner.ts`; orchestration design notes are in `docs/box-provisioning.md`.
- **Provider registry** — `backend/src/providers/registry.ts` and `frontend/src/providers/registry.ts` define the set of supported agent providers (codex, claude, mistral/vibe, devin, …) and their metadata: display name, launch command shape, status normalization rules, **tmux poller config** (idle/working detection patterns per provider, since e.g. vibe has a persistent input box that breaks naive polling), **usage scanner source** (Codex JSONL, Claude logs, vibe `~/.vibe/logs/session/meta.json`), and UI affordances. `agentProvider` is a free-form string keyed into the registry rather than a Prisma enum, so adding a provider is a code change in two registry files (no migration). Each user also has a saved `defaultAgentProvider` for the create-project form.
- **Per-user agent process** — `agent/agent.js` runs as the unix user (via systemd user service + lingering). It owns tmux attach, node-pty, filesystem ops, and Codex-bridge lifecycle. The main server at `:3040` is one process; each user has their own agent talking to it via WebSocket with a bearer token. This separation keeps unix permissions clean. The agent now uses heartbeat-driven dead-connection detection and accepts a config path override via `argv[2]`.
- **Status events** — Claude Code hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`) and Codex app-server status updates POST to `:3040/termag/api/status`. For providers without a hook surface (vibe), the **tmux poller** in `backend/src/services/tmuxPoller.ts` samples pane content and infers state using provider-specific patterns. Status drives the green/yellow/red indicators, the project-list transition flash (15s, color-coded green/yellow/red by transition type — e.g. idle→working green, working→waiting yellow, anything→idle red), and the "hyperspace" animation that speeds up with activity. The `Notification` hook distinguishes `idle_prompt` (idle) from other notifications (waiting). Status events also bump `Project.lastActiveAt`, which feeds the recent-activity sort.
- **Context-token warnings** — the per-user agent scrapes provider-specific "context remaining" strings out of the agent pane and forwards them through the status pipeline as a separate signal alongside working/waiting/idle. The UI surfaces this on the project tile and inside the terminal chrome so a session that's about to run out of context gets a visible warning before it hard-fails.
- **Rate-limit detection** — same shape as context-token warnings: the per-user agent (`agent/agent.js`) watches the agent pane for provider-specific rate-limit / quota-exhausted messages and forwards a `rateLimited` signal through the status pipeline. The backend persists it on the project's status record and the UI surfaces it on the project tile and in `ProjectControl` so a stuck session is visually distinguishable from a merely-idle one.
- **Working-time tracking** — derived from status transitions: time spent in `working` state is rolled up per-project for the usage dashboard. Provider-specific poller sources ensure correct attribution. Served from `/termag/api/worktime`.
- **Human activity tracking** — `backend/src/services/humanActivity.ts` tracks human keystrokes/interactions per project, separate from agent working time. Powers the second tube of the two-tube thermometer in the UI (agent work vs. human work).
- **Project visit telemetry** — `ProjectVisit` records when a user context-switches between projects in the UI. `backend/src/routes/visits.ts` exposes ingest + stats endpoints; the UsageMini overlay renders a visits section derived from them.
- **Warp / flow-speed telemetry** — `WarpSample` stores per-minute rollups of the hyperspace-speed signal. `backend/src/services/warpSampler.ts` produces the samples and `backend/src/routes/warp.ts` exposes a series endpoint feeding flow-speed sections in UsageMini.
- **Project sharing** — owners can invite collaborators by email. Shared users get terminal access to the project's tmux sessions through the same per-user-agent path. Routes in `backend/src/routes/sharing.ts`.
- **Status WebSocket** — `/termag/ws/status` pushes status events to anyone subscribed (the UI itself, plus opt-in external consumers). Idle browser WebSockets are kept alive with a server-side heartbeat.

## Repository Layout

```
termag/
├── backend/                        Express + TS server, port 3040
│   ├── src/
│   │   ├── auth/                   ALLOWED_USERS parser (incl. domain wildcards) + tests
│   │   ├── routes/                 REST: projects, status, usage, worktime, sharing, auth,
│   │   │                            instances (box CRUD), workstreams, visits, warp
│   │   ├── providers/registry.ts   Provider registry — adding a provider lives here
│   │   ├── services/               tmux, tmuxPoller, status, humanActivity, agentRegistry,
│   │   │                            agentRuntime (session reconstruction on reconnect),
│   │   │                            boxProvisioner (AWS box provisioning), warpSampler,
│   │   │                            workstreams (git-worktree management), usage tracking
│   │   └── middleware/auth.ts      Google OAuth gate + email→unixuser mapping + dev-login bypass
│   └── prisma/                     schema + migrations
├── frontend/                       React 18 + Vite, basename /termag
│   └── src/
│       ├── components/             Terminal (xterm.js), ProjectControl, UsageMini (two-tube
│       │                            thermometers + 7d/30d human-activity charts + visits +
│       │                            flow-speed sections), Hyperspace
│       ├── providers/registry.ts   Mirror of backend provider registry — must stay in sync
│       ├── contexts/               AuthContext, ProjectContext
│       └── services/               REST + WebSocket clients
├── agent/                          Per-user agent (plain JS, no build step)
│   ├── agent.js                    main entry — WebSocket to backend, node-pty + tmux attach,
│   │                                heartbeat-driven dead-connection detection
│   ├── codex-status-bridge.js      Codex app-server status normalization
│   ├── codex-status-normalizer.js
│   ├── agent.config.example.json   sample per-user agent config
│   └── initial-AGENTS.md           template seeded into new projects on creation
├── relay/                          Chrome tab-capture relay (runs on user's laptop)
├── packer/                         AMI build for box images (Packer config + setup.sh)
├── terraform/
│   └── box/                        Terraform module for AWS box provisioning (AMI discovered by tag)
├── docs/
│   └── box-provisioning.md         Design doc for orchestrator-driven box provisioning
└── deploy/                         systemd units, Apache snippet, claude-hooks.md, setup walkthrough (Linux + macOS)
```

## Architecture

```
Browser ──https──▶ Apache (:443, /termag/*)
                    ├── /termag/ws/*    → ws://localhost:3040/termag/ws/*    (terminal streams + status push)
                    └── /termag/*       → http://localhost:3040/termag/*

Backend (single process, systemd "termag", root or service user, port 3040)
  ├── REST API     /termag/api/* (projects, status, usage, worktime, instances, workstreams, visits, warp, auth)
  ├── WebSocket    /termag/ws/terminal/<sessionId>  PTY stream
  │                /termag/ws/status                fan-out push (+ idle heartbeat)
  │                /termag/ws/agent                 per-user agent connections
  ├── tmux poller  Periodically samples tmux session state as a fallback signal
  ├── boxProvisioner  Drives AWS provisioning via the Terraform box module + Packer AMI
  ├── Slack Bolt   Socket Mode (no public webhook needed)
  └── Postgres     prisma schema + sessions via connect-pg-simple

Orchestrator + boxes (one orchestrator, N termag-running boxes)
  ├── Instance model in Postgres; Project.instanceId / AgentToken.instanceId route work to a box
  └── "Add box" button → boxProvisioner → Terraform → EC2 instance from the Packer AMI,
                          renamed to the owner's unix user during cloud-init

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

**Trade-off: orchestrator-driven box provisioning vs manual `terraform apply`** — chose orchestrator-driven (`boxProvisioner.ts` shells out to Terraform with the box module). The orchestrator owns the lifecycle so the UI's "Add box" button is the only path users see, and `Instance` rows stay in sync with what actually exists in AWS. Cost: the backend needs AWS creds and Terraform on `PATH`.

## Data & Schema

`backend/prisma/schema.prisma`. Key models (not exhaustive):

| Model | Purpose |
|-------|---------|
| `User` | Google identity + mapped unix user. Holds `defaultAgentProvider` (string), agent token records, usage rollups. |
| `Project` | Name, working dir, `agentProvider` (string keyed into the provider registry, no longer an enum), Slack channel id, archived flag, owner, `pinned` flag and `lastActiveAt` timestamp (drive project-list ordering: pinned first, then recent activity), and `instanceId` (which box hosts the project). |
| `Instance` | A termag-running host ("box"). Tracks provisioning state, AWS identifiers, and the owning unix user. Populated by `boxProvisioner` and the `/termag/api/instances` routes. |
| `Workstream` | A named line of work inside a project, backed by a git worktree. Every project has a `main` workstream auto-created on project creation; additional workstreams are managed through `backend/src/routes/workstreams.ts`. |
| `ProjectShare` | Collaborator grants on a project — `(projectId, userId)` with role. Backs the sharing routes; lets a non-owner reach the owner's tmux sessions through their own agent. |
| `AgentToken` | Bearer token for a per-user agent connection. Issued from the UI sidebar. Now carries `instanceId` so a token is scoped to a specific box. |
| `StatusEvent` | Append-only log of `working/waiting/idle` events; backs the status WebSocket, the "hyperspace" activity score, the project-list transition flash, and worktime rollups. Status writes also bump `Project.lastActiveAt`. |
| `WorkTime` | Per-project rollup of time spent in `working` state, derived from `StatusEvent`. Powers `/termag/api/worktime`. |
| `HumanActivity` | Per-project rollup of human keystroke/interaction time, derived from terminal input events. Powers the human tube of the two-tube thermometer. |
| `UsageEvent` | Per-call API usage (tokens, cost) for the dashboard. Provider-specific scanners populate this (Codex JSONL, Claude logs, vibe `~/.vibe/logs/session/meta.json`). |
| `ProjectVisit` | Per-user context-switch log: when the UI focus moves between projects. Feeds the visits section of the UsageMini overlay via `/termag/api/visits`. |
| `WarpSample` | Per-minute rollups of the hyperspace-speed signal. Produced by `warpSampler` and exposed via `/termag/api/warp` for the flow-speed sections of UsageMini. |
| `session` | Managed by `connect-pg-simple`, NOT in `schema.prisma`. Created by the SQL block in `deploy/setup.md`. |

Migration history (recent):
- `20260427000000_provider_string_and_worktime` — `agentProvider` moved from enum to string; worktime rollups added.
- `20260427100000_project_sharing` — `ProjectShare` table.
- `20260503000000_add_project_pinned_and_lastActiveAt` — pin + recent-activity sort fields.
- `20260512000000_add_telemetry_visits_and_warp_samples` — `ProjectVisit` and `WarpSample`.
- `20260528000000_add_instance_model` — `Instance`, `Project.instanceId`, `AgentToken.instanceId`.
- `20260529000000_add_box_provisioning_columns` — provisioning-state columns on `Instance`.
- `20260531230943_workstreams` — `Workstream` model + every-project-gets-`main` backfill.

`prisma migrate dev` is fine here (this is an interactive box); on non-interactive deploy targets prefer `db push`.

## Configuration

`backend/.env` (gitignored). Key vars (see `.env.example` for the full list):

| Var | Notes |
|-----|-------|
| `DATABASE_URL` | Postgres |
| `SESSION_SECRET` | random hex |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth |
| `ALLOWED_USERS` | comma-separated `email:unixuser` pairs. Supports domain wildcards (e.g. `*@example.com:default-unixuser`). |
| `SLACK_BOT_TOKEN` (`xoxb-`), `SLACK_APP_TOKEN` (`xapp-`), `SLACK_SIGNING_SECRET` | Slack Socket Mode |
| `CAPTURE_API_SECRET` | shared secret used by external pane-capture relays |
| `DEV_LOGIN_ENABLED` / `DEV_LOGIN_EMAIL` | local-development OAuth bypass — leave unset in production |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | used by `boxProvisioner` + the Terraform box module for "Add box" provisioning |
| `BOX_AMI_TAG` | AMI tag used by `terraform/box` to discover the Packer-baked image at apply time |
| `PORT` | `3040` |

Per-user agent: `~/.config/termag/agent.config.json` with `server_url` (`ws://localhost:3040/termag/ws/agent`) and `token` (created in the UI sidebar → Agent Tokens). The agent now also accepts a config-path override as `argv[2]` and falls back to the example config if the per-user file is missing.

## Build, Run, Deploy

```bash
# build
cd backend && npm install && npm run build
cd ../frontend && npm install && npm run build

# run main server
sudo systemctl daemon-reload && sudo systemctl enable --now termag

# run per-user agent (as that user, Linux)
mkdir -p ~/.config/systemd/user
cp deploy/termag-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now termag-agent
sudo loginctl enable-linger <username>     # so it runs without an active login

# wire Claude Code hooks (per user)
# add the JSON block from deploy/claude-hooks.md to ~/.claude/settings.json

# build a box AMI (one-time per image refresh)
cd packer && packer init . && packer build box.pkr.hcl

# provision a box manually (UI's "Add box" button does this end-to-end)
cd terraform/box && terraform init && terraform apply
```

Apache snippet in `deploy/apache.conf`. See `deploy/setup.md` for the canonical first-time walkthrough (covers both Linux/systemd and macOS/launchd for the per-user agent); `deploy/claude-hooks.md` for the hook config; `docs/box-provisioning.md` for the orchestrator-driven box-provisioning design.

**macOS note** — the per-user agent runs under `launchd` instead of `systemd --user`. There's no linger equivalent; the LaunchAgent plist (`~/Library/LaunchAgents/`) handles auto-start at login. See `deploy/setup.md` for the plist template and `launchctl` commands.

**Pre-commit** — a `gitleaks` hook is configured in `.pre-commit-config.yaml` with rules in `.gitleaks.toml`. Run `pre-commit install` once after cloning so leaked AWS / Slack / OAuth credentials get caught before they land in history.

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
| `POST /termag/api/projects` | Create project (also creates tmux sessions, Slack channel, seeds AGENTS.md + CLAUDE.md, creates `main` workstream) |
| `POST /termag/api/status` | Status update from Claude hooks / Codex bridge — primary write path |
| `GET /termag/api/usage/...` | Token + cost rollups for the dashboard (provider-specific scanners) |
| `GET /termag/api/worktime` | Working-time rollups by provider (agent + human), derived from `StatusEvent` and heartbeats; thermometers use an absolute 8h scale |
| `POST /termag/api/status/heartbeat` | Human activity heartbeat from the UI (fires every 30s while typing); 3-min decay banks to `work_time_entries` with `provider: "human"` |
| `POST /termag/api/projects/:id/invite` | Invite a collaborator by email |
| `GET /termag/api/invites` | List pending invites for the logged-in user |
| `POST /termag/api/invites/:id/accept` | Accept a project invite |
| `DELETE /termag/api/projects/:id/shares/:shareId` | Revoke a collaborator's access |
| `GET/POST/DELETE /termag/api/instances` | Box CRUD — list, provision ("Add box"), decommission |
| `GET/POST/DELETE /termag/api/projects/:id/workstreams` | Workstream CRUD; agent RPCs manage the underlying git worktrees |
| `POST /termag/api/visits` / `GET /termag/api/visits/stats` | Project-visit ingest + stats for the UsageMini visits section |
| `GET /termag/api/warp/series` | Per-minute warp/flow-speed rollups for the UsageMini flow-speed section |
| `WS /termag/ws/terminal/<sessionId>` | PTY stream (bidirectional) |
| `WS /termag/ws/status` | Status push fan-out — consumed by the UI and any opt-in external listener (idle-heartbeat keeps browser connections alive) |
| `WS /termag/ws/agent` | Per-user agent connection (bearer-token auth, dual-keyed by `instanceId`) |

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

2. **`loginctl enable-linger <user>` is mandatory (Linux)** — without it, the per-user agent stops the moment the user logs out, which makes everything in the UI hang the next time termag tries to talk to that user's agent. macOS uses launchd LaunchAgents instead and has no linger equivalent.

3. **`session` table is owned by `connect-pg-simple`, not Prisma** — don't add it to `schema.prisma`. The `CREATE TABLE` SQL is in `deploy/setup.md` and must be run once after creating the DB.

4. **Slack scopes are large** — the bot needs `app_mentions:read`, `chat:write`, `channels:manage`, `channels:read`, `commands`, `im:history`, `im:read`, `im:write`, `files:read`, `reactions:read`, `reactions:write`, `users:read`, `users:read.email`. Re-add any you remove and reinstall the app or `/t create` will silently fail to create channels.

5. **WebSocket upgrade ordering in Apache** — `/termag/ws/*` ProxyPass MUST come before the plain `/termag/*` ProxyPass in the vhost, otherwise socket upgrades fall through to plain HTTP and the terminal never connects.

6. **`ALLOWED_USERS` maps email→unixuser** — both columns matter. A typo in the unixuser half doesn't fail OAuth; it fails later when the per-user agent can't be reached because no such systemd user service is running. Domain-wildcard entries (`*@example.com:default-unixuser`) match any email from that domain to the same unix user — handy, but it means a typo in the wildcard half silently routes everyone to the wrong account.

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

20. **Stale `waiting` status is auto-cleared by the per-user agent** — `agent/agent.js` watches for sessions stuck in `waiting` whose pane no longer shows a prompt and demotes them back to `idle`/`working` to match reality. Hooks and bridges aren't perfectly reliable about firing the closing event (notably Claude `Notification` → no follow-up `UserPromptSubmit` if the user dismisses outside the TUI), so the agent is the safety net. If you see a project tile flicker out of `waiting` without an obvious trigger, that's this — don't chase it as a hook bug first.

21. **Agent reconnect reconstructs sessions from the backend's view, not the agent's** — when a per-user agent reconnects (restart, network blip, laptop wake), `backend/src/services/agentRuntime.ts` replays the project/session state down to the agent so existing tmux sessions get reattached without the user re-clicking everything. The backend is authoritative for "what sessions should exist"; the agent is authoritative for "what tmux currently has." If they disagree after a reconnect (ghost sessions, missing reattach), the reconciliation logic in `agentRuntime.ts` is where to look — not the agent's own startup path.

22. **`ensureAgentSessionsAndLaunch` probes before relaunching** — on reconnect / sleep-wake the runtime first probes whether the agent's tmux sessions are still alive and only relaunches the agent process when they're actually gone. If you add a code path that calls into this and it starts double-launching agents, you've skipped the probe; don't.

23. **EC2 security-group descriptions must be ASCII** — `terraform/box` had to swap an em-dash out of an SG description because EC2 rejects non-ASCII characters there. Anything you add to `main.tf` / `variables.tf` describing AWS resources should stay ASCII-only.

24. **Boxes are provisioned per-Unix-user** — the Packer AMI ships with a `termag` default unix user, and cloud-init renames it to the project owner's username during provisioning. Don't hardcode `termag` as the unix user anywhere on the box; reference `$USER` or the value set by cloud-init.

25. **Terraform discovers the AMI by tag, not by id** — `terraform/box` looks up the latest AMI matching `BOX_AMI_TAG` at apply time instead of taking an explicit `var.ami_id`. Rebuilding the AMI with Packer is enough to roll boxes forward; bumping a variable isn't required, but a stale or missing tag will break `terraform apply` with a non-obvious "no matching AMI" error.

26. **Every project has a `main` workstream by default** — phase-1 invariant. Tmux helpers and the agent runtime thread the workstream id through session naming, but legacy code paths that don't pass one will land on `main`. If you add a new code path that creates project artifacts (worktree, tmux session, status event), pass the workstream id explicitly rather than relying on the implicit `main`.

27. **`DEV_LOGIN_ENABLED` is a local-development bypass** — when set, the OAuth gate is short-circuited to `DEV_LOGIN_EMAIL`. Never set it in production; the bypass deliberately doesn't check `ALLOWED_USERS` the same way the real path does. The dev-login parse path was tweaked when `parseAllowedUsers` changed shape, so if dev-login regresses, that pairing is the first thing to check.

## Related

**Other projects:**
- [agent-wiki](https://github.com/psecor/agent-wiki) — the docs spec this project's `AGENTS.md` follows; consumes nothing from termag at runtime

**Topics:** none yet.
