---
project: termag
status: production
status_description: 'Multi-user workspace orchestrator. Runs paired tmux sessions per project, web terminals via xterm.js + WebSocket, multi-provider agent choice (Codex, Claude, Mistral/vibe, Devin), Slack + Discord integration, project sharing with collaborators, two-tube thermometer UI tracking agent working time and human activity, pinned/recent-activity-sorted project list, on-demand EC2 box provisioning via the AWS SDK from a Packer-baked AMI ("Add box" button) with projects routed by `Instance`, per-project git-worktree workstreams (every project starts with `main`), and visit/flow-speed telemetry (ProjectVisit + WarpSample) surfaced in the usage overlay.'
last_updated: 2026-09-01
last_updated_by:
  - agent:claude-opus-4-6
  - agent:claude-opus-4-7
  - agent:sweeper-claude-opus-4-7
  - agent:claude-opus-5
wiki_schema_version: 1
---

# AGENTS.md — termag

## What This Is

A multi-user workspace manager for running AI coding agents in parallel. Each project gets a paired set of tmux sessions — an **agent** pane (Codex, Claude Code, or other agents) and a **ctrl** pane (regular terminal for sudo / interactive auth / things the agent can't run). The web UI renders both terminals side-by-side with xterm.js, shows real-time agent status (working/waiting/idle from Claude hooks + Codex app-server), and exposes per-project usage and a Slack `/t` command surface.

Auth is Google OAuth with an `ALLOWED_USERS` allowlist mapping `email:unixuser`.

## Status

Production-ready. Provider registry covers Codex, Claude, Mistral (vibe), Devin, and pi (pi on the self-hosted model catalog); per-project working-time and human-activity tracking feed a two-tube thermometer UI; project sharing lets owners invite collaborators with terminal access; new projects get seeded `AGENTS.md` and `CLAUDE.md`. The orchestrator can now provision additional EC2 "boxes" on demand (the backend calls the AWS SDK to launch a Packer-baked AMI, surfaced as "a new box…" in the New project dialog) and route projects to a specific `Instance` via `Project.instanceId`. Every project carries a `main` workstream backed by a git worktree, with CRUD routes for additional workstreams. Visit + flow-speed telemetry (`ProjectVisit` for context switches, `WarpSample` for per-minute hyperspace-speed rollups) feeds new sections in the UsageMini overlay.

## Domain Model

- **Project** — an addressable workspace. Has a name, a working directory, an `agent` workflow (the paired tmux sessions), persisted `agentProvider` (string id resolved through the provider registry), and a Slack channel `#proj-<user>-<name>` auto-created on creation (legacy channels are `#proj-<name>`; both route). New projects are seeded with `AGENTS.md` (from the agent-wiki initial template) and a `CLAUDE.md` stub. Projects also carry a `pinned` flag and a `lastActiveAt` timestamp that drive the project list ordering: pinned projects float to the top, then the rest sort by recent activity. Pin/unpin and other per-project actions live in an overflow menu on each project tile. Each project is bound to an `Instance` (box) via `Project.instanceId`; routing decisions key off that field.
- **Paired tmux sessions** — `<unixuser>-<project>-agent` (where the AI runs) and `<unixuser>-<project>-ctrl` (regular shell). tmux turns `.` and `:` in a session name into `_`, so `sessionName()` (backend `services/tmux.ts`, frontend `utils/sessionName.ts`) builds names in that form (`first.last` → `first_last-<project>-agent`) and ownership checks compare against the tmux-safe username (`sessionBelongsToUser`). The web UI streams both via PTY + WebSocket. A third, transient role is `-review`: the **Review** button in the lower-right of the agent pane guesses the PR being worked on (the branch's PR via `gh`, else the PR the agent just opened, else the last PR mentioned in the pane), asks you to confirm or retype it, and starts `devin` with a review prompt in `<unixuser>-<project>-review`; the pane docks under the ctrl terminal (collapsed bar / half-height) and disappears when its session is killed (`backend/src/routes/review.ts`, `services/review.ts`, `frontend/src/components/ReviewButton.tsx` + `ReviewDock.tsx`). Tmux helpers and the agent runtime are workstream-aware: every project gets a `main` workstream, and additional workstreams are realized as git worktrees with their own paired tmux sessions.
- **Workstream** — a named parallel line of work inside a project, backed by a git worktree. Every project has a `main` workstream auto-created on project creation; additional workstreams are managed through `backend/src/routes/workstreams.ts` (orchestrator) and the `git-worktree-add` / `git-worktree-remove` / `git-worktree-move` RPCs in `agent/agent.js` (rename also uses `tmux-rename-session`; the git branch is deliberately not renamed — `services/workstreamRename.ts`). Workstreams live at `<projectDir>/.worktrees/<name>/`. Tmux session naming threads the workstream id through (`<user>-<project>-<workstream>-<role>`, collapsing the workstream segment to keep historical names when it's `main`). Branching off mirrors the project's main-workstream `Workflow` rows onto the new workstream (one per workstream, since the legacy `(projectId, type)` unique was dropped) and launches its tmux sessions so the terminal pane can attach immediately. The UI surfaces a workstream sub-list under projects with >1 workstream and a "Branch off…" overflow action; single-workstream projects render exactly as before.
- **Instance ("box")** — a termag-running host. The orchestrator can provision additional boxes on AWS with the AWS SDK, launching the Packer-baked AMI (`packer/`) from the UI's **New project** dialog ("a new box…" in its box picker, `frontend/src/components/NewProjectForm.tsx`, shared with the `/welcome` wizard; adding a managed box requires a stored GitHub token, `boxGate`); self-managed hosts are registered from the sidebar's Boxes section. `Project.instanceId` and `AgentToken.instanceId` key off the `Instance` model so projects and per-user agent tokens are dual-keyed by host. Provisioning lives in `backend/src/services/boxProvisioner.ts`; orchestration design notes are in `docs/box-provisioning.md`. The owner can **stop and start** an EC2 box from its menu (`POST /api/instances/:id/stop|start`, `services/boxPower.ts`, rules in `boxPowerPolicy.ts`): `ready → stopping → stopped` is settled by a 10 s power sweep from `DescribeInstances`, and `stopped → starting → ready` by the agent's connect, after which `reconstructInstanceSessions` recreates the tmux sessions (Claude relaunches with `claude --continue`). A stopped box costs only its EBS volumes; creating a project, workflow or workstream on it answers 409. A box launched hibernation-capable (`Instance.hibernationConfigured`) can also be **hibernated** (`POST /api/instances/:id/hibernate`): `ready → hibernating → hibernated`, and a start resumes it with its RAM (`docs/box-hibernation.md`).
- **Provider registry** — `backend/src/providers/registry.ts` and `frontend/src/providers/registry.ts` define the set of supported agent providers (codex, claude, mistral/vibe, devin, pi, …) and their metadata: display name, launch command shape, status normalization rules, **tmux poller config** (idle/working detection patterns per provider, since e.g. vibe has a persistent input box that breaks naive polling), **usage scanner source** (Codex JSONL, Claude logs, vibe `~/.vibe/logs/session/meta.json`), and UI affordances. `agentProvider` is a free-form string keyed into the registry rather than a Prisma enum, so adding a provider is a code change in two registry files (no migration). Each user also has a saved `defaultAgentProvider` for the create-project form.
- **Per-user agent process** — `agent/agent.js` runs as the unix user (via systemd user service + lingering). It owns tmux attach, node-pty, filesystem ops, and Codex-bridge lifecycle. The main server at `:3040` is one process; each user has their own agent talking to it via WebSocket with a bearer token. This separation keeps unix permissions clean. The agent now uses heartbeat-driven dead-connection detection and accepts a config path override via `argv[2]`.
- **Status events** — Claude Code hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`) and Codex app-server status updates POST to `:3040/termag/api/status`. For providers without a hook surface (vibe), the **tmux poller** in `backend/src/services/tmuxPoller.ts` samples pane content and infers state using provider-specific patterns. Status drives the green/yellow/red indicators, the project-list transition flash (15s, color-coded green/yellow/red by transition type — e.g. idle→working green, working→waiting yellow, anything→idle red), and the "hyperspace" animation that speeds up with activity. The `Notification` hook distinguishes `idle_prompt` (idle) from other notifications (waiting). Status events also bump `Project.lastActiveAt`, which feeds the recent-activity sort.
- **Context-token warnings** — the per-user agent scrapes provider-specific "context remaining" strings out of the agent pane and forwards them through the status pipeline as a separate signal alongside working/waiting/idle. The UI surfaces this on the project tile and inside the terminal chrome so a session that's about to run out of context gets a visible warning before it hard-fails.
- **Rate-limit detection** — same shape as context-token warnings: the per-user agent (`agent/agent.js`) watches the agent pane for provider-specific rate-limit / quota-exhausted messages and forwards a `rateLimited` signal through the status pipeline. The backend persists it on the project's status record and the UI surfaces it on the project tile and in `ProjectControl` so a stuck session is visually distinguishable from a merely-idle one.
- **Working-time tracking** — derived from status transitions: time spent in `working` state is rolled up per-project for the usage dashboard. Provider-specific poller sources ensure correct attribution. Served from `/termag/api/worktime`.
- **Human activity tracking** — `backend/src/services/humanActivity.ts` tracks human keystrokes/interactions per project, separate from agent working time. Powers the second tube of the two-tube thermometer in the UI (agent work vs. human work).
- **Project visit telemetry** — `ProjectVisit` records when a user context-switches between projects in the UI. `backend/src/routes/visits.ts` exposes ingest + stats endpoints; the UsageMini overlay renders a visits section derived from them.
- **Warp / flow-speed telemetry** — `WarpSample` stores per-minute rollups of the hyperspace-speed signal. `backend/src/services/warpSampler.ts` produces the samples and `backend/src/routes/warp.ts` exposes a series endpoint feeding flow-speed sections in UsageMini.
- **Project sharing** — owners can invite collaborators by email. Shared users get terminal access to the project's tmux sessions through the same per-user-agent path. Routes in `backend/src/routes/sharing.ts`.
- **Admin surface** — org-wide, read-only view for administrators: `/termag/admin` UI, `/termag/api/admin/*` REST and a Streamable HTTP MCP server at `/termag/mcp/admin`, all behind `requireAdmin` (`middleware/admin.ts`). Admins are `users.role = 'admin'`, seeded at startup from `ADMIN_USERS` or granted from the Settings tab; admin-scoped bearer tokens (`agent_tokens.scope = 'admin'`) serve MCP clients and scripts. Every admin request and tool call lands in `admin_audit_log`. Aggregates and metadata only — never pane content.
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
│       ├── theme/                  schema.ts (mirror of backend/src/theme/schema.ts — must stay
│       │                            in sync), ThemeProvider (CSS variables on <html>), apply.ts
│       └── services/               REST + WebSocket clients
├── agent/                          Per-user agent (plain JS, no build step)
│   ├── agent.js                    main entry — WebSocket to backend, node-pty + tmux attach,
│   │                                heartbeat-driven dead-connection detection
│   ├── codex-status-bridge.js      Codex app-server status normalization
│   ├── codex-status-normalizer.js
│   ├── xclip-shim.sh               fake xclip installed at ~/.local/bin/xclip so Claude Code's
│   │                                Ctrl+V image paste finds the browser's image (+ .test.sh)
│   ├── agent.config.example.json   sample per-user agent config
│   └── initial-AGENTS.md           template seeded into new projects on creation
├── relay/                          Chrome tab-capture relay (runs on user's laptop)
├── packer/                         AMI build for box images (Packer config + setup.sh)
├── terraform/
│   └── box/                        V1 Terraform shape of a box, reference only (boxProvisioner is the live path)
├── docs/
│   ├── box-provisioning.md         Design doc for orchestrator-driven box provisioning
│   ├── orchestrator-rds.md         The orchestrator's database on Aurora: design, cutover runbook
│   ├── hosted-apps.md              How to host extra apps on ALB suburls via the nginx gateway
│   ├── hosted-apps-migration.md    Moving those apps off the dev orchestrator host (status + plan)
│   ├── host-storage-handoff.md     How the host data volume moves to a new orchestrator; runbook
│   └── project-migration.md        Design: moving a project and its workstreams between boxes
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
  ├── boxProvisioner  Launches boxes with the AWS SDK (EC2 + IAM) from the Packer AMI
  ├── Slack Bolt   Socket Mode (no public webhook needed)
  └── Postgres     prisma schema + sessions via connect-pg-simple

Orchestrator + boxes (one orchestrator, N termag-running boxes)
  ├── Instance model in Postgres; Project.instanceId / AgentToken.instanceId route work to a box
  └── New project dialog ("a new box…") → boxProvisioner → AWS SDK → EC2 instance from the Packer AMI,
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

**Trade-off: orchestrator-driven box provisioning vs manual `terraform apply`** — chose orchestrator-driven (`boxProvisioner.ts` calls the AWS SDK itself: `DescribeImages`, `CreateSecurityGroup`, `CreateRole` with a permissions boundary, then `RunInstances`). The orchestrator owns the lifecycle so the UI's "Add box" button is the only path users see, and `Instance` rows stay in sync with what actually exists in AWS. Cost: the backend needs credentials for the box account and the IAM grant with its permissions boundary, and termag now owns the EC2, security-group, and IAM lifecycle that Terraform used to own.

## Data & Schema

`backend/prisma/schema.prisma`. Key models (not exhaustive):

| Model | Purpose |
|-------|---------|
| `User` | Google identity + mapped unix user. Holds `defaultAgentProvider` (string), `theme` (JSON — background mode and colour, shape in `src/theme/schema.ts`, `{}` = defaults), agent token records, usage rollups, `role`/`adminSource` (admin authorization), `lastSeenAt` (bumped by the auth gates at most once per 5 min). |
| `Project` | Name, working dir, `agentProvider` (string keyed into the provider registry, no longer an enum), Slack channel id, archived flag, owner, `pinned` flag and `lastActiveAt` timestamp (drive project-list ordering: pinned first, then recent activity), and `instanceId` (which box hosts the project). |
| `Instance` | A termag-running host ("box"). Tracks provisioning state, AWS identifiers, and the owning unix user. It also holds the agent's host sample (`diskUsedPct`, `memUsedPct`, `load1`, `keptCheckouts`, `hostSampledAt`) from its hello and the `host-sample` RPC every five minutes (`services/hostSamples.ts`), shown on Fleet and behind the `box_pressure` signal. `readyAt` holds the first agent connect, so `readyAt - createdAt` is that box's cold-provisioning time. `cleanedUpAt` is set only when a terminated ec2 box's AWS teardown fully finished; the provisioning sweep re-runs teardown for terminated rows without it (`docs/box-provisioning.md`). Populated by `boxProvisioner` and the `/termag/api/instances` routes. |
| `Workstream` | A named line of work inside a project, backed by a git worktree. Every project has a `main` workstream auto-created on project creation; additional workstreams are managed through `backend/src/routes/workstreams.ts`. Non-main workstreams carry their own `slackChannelId` (`#proj-<user>-<project>-<workstream>`, auto-created and archived with the workstream); `main` uses `Project.slackChannelId`. |
| `ProjectShare` | Collaborator grants on a project — `(projectId, userId)` with role. Backs the sharing routes; lets a non-owner reach the owner's tmux sessions through their own agent. |
| `ClaudeRunnerSession` | One row per **run** of a Claude Code cloud session on a box (one order each): owner, box, slot, `startedAt`, the end the box reports through `POST /api/claude-runner/event` (`endedAt`, `exitStatus`, `exitReason`), and since the Anthropic `sessionId` that groups runs into sessions, the `clientPlatform` from the box's `started` report, and the owner-only `title` (first prompt's first line, copied to a new run of the same session). It also holds the token usage the session posts about itself (`inputTokens` … `usageAt`, `model`), read by every token report as provider `claude-cloud` through `services/admin/tokenSource.ts`; the usage scanner never sees these sessions. |
| `ClaudeSessionEvent` | Append-only log of what happened to a cloud session, keyed by `sessionId`: every spawn outcome (`queued` with the refusal reason, `placed`, `already-running`, `agent-failed`), the box's `started` and `ended`, the reconciler's `lost`, an `end-requested` from the UI. `detail` never holds an email, a token or prompt text. Swept after 30 days; run rows after 90 (`services/claudeSessions.ts`). |
| `AgentToken` | Bearer token for a per-user agent connection. Issued from the UI sidebar. Carries `instanceId` so a token is scoped to a specific box, plus `scope` (`agent` default, `admin` for the admin surface) and an optional `expiresAt`. `/ws/agent`, the agent-facing REST routes and `/api/cli/v1`'s box credential accept only `agent`; `requireAdmin` accepts only `admin`. The CLI and `termag tui` sign in with `cli_sessions` (`tmcli_`), not this table. |
| `StatusEvent` | Append-only log of `working/waiting/idle` events; backs the status WebSocket, the "hyperspace" activity score, the project-list transition flash, and worktime rollups. Status writes also bump `Project.lastActiveAt`. |
| `WorkTime` | Per-project rollup of time spent in `working` state, derived from `StatusEvent`. Powers `/termag/api/worktime`. |
| `HumanActivity` | Per-project rollup of human keystroke/interaction time, derived from terminal input events. Powers the human tube of the two-tube thermometer. |
| `UsageEvent` | Per-call API usage (tokens, cost) for the dashboard. Provider-specific scanners populate this (Codex JSONL, Claude logs, vibe `~/.vibe/logs/session/meta.json`). |
| `ProjectVisit` | Per-user context-switch log: when the UI focus moves between projects. Feeds the visits section of the UsageMini overlay via `/termag/api/visits`. |
| `WarpSample` | Per-minute rollups of the hyperspace-speed signal. Produced by `warpSampler` and exposed via `/termag/api/warp` for the flow-speed sections of UsageMini. |
| `AdminAuditLog` | Every admin REST request and MCP tool call: actor, token if any, surface, action, args summary, outcome. Never pruned automatically. |
| `session` | `connect-pg-simple`'s session store. Declared in `schema.prisma` as model `Session` (`@@map("session")`) ONLY so `prisma db push` creates/keeps it under the migration DB user; the app never reads or writes it through Prisma. |

Migration history (recent):
- `20260427000000_provider_string_and_worktime` — `agentProvider` moved from enum to string; worktime rollups added.
- `20260427100000_project_sharing` — `ProjectShare` table.
- `20260503000000_add_project_pinned_and_lastActiveAt` — pin + recent-activity sort fields.
- `20260512000000_add_telemetry_visits_and_warp_samples` — `ProjectVisit` and `WarpSample`.
- `20260528000000_add_instance_model` — `Instance`, `Project.instanceId`, `AgentToken.instanceId`.
- `20260529000000_add_box_provisioning_columns` — provisioning-state columns on `Instance`.
- `20260531230943_workstreams` — `Workstream` model + every-project-gets-`main` backfill.
- `20260601011055_drop_workflow_project_unique` — drops the legacy `(projectId, type)` unique on `workflows` so a project can carry one workflow per workstream; `(workstreamId, type)` remains as the per-workstream guarantee.
- `20260921000000_instance_ready_at` — `Instance.readyAt`, the write-once first-agent-connect timestamp behind the cold-provisioning baseline.
- `20261007000000_instance_cleanup` — `Instance.cleanedUpAt` / `cleanupAttemptedAt`, behind the teardown retry sweep.
- `20261007000001_instance_profile_handle` — `Instance.iamInstanceProfileName`, so teardown's completion stamp sees a profile a concurrent launch created after it.
- `20261008000000_claude_runner_sessions` — `ClaudeRunnerSession`, the per-session record a box's end-of-session report completes.
- `20261008150000_claude_session_events` — `sessionId`, `clientPlatform`, `title` on `ClaudeRunnerSession`; `ClaudeSessionEvent`.

`prisma migrate dev` is fine here (this is an interactive box); on non-interactive deploy targets prefer `db push`.

**Schema changes are expand, then contract.** During an overlapping deploy the old and new orchestrator share the database, and the new one syncs with `DB_PUSH_MODE=additive`, which skips drops. So add first (nullable or defaulted; write both shapes, read the new one with a fallback), and drop the old shape only in a later release, by hand. A rename, a type change old code can't read, or a `NOT NULL` column without a default breaks the old process mid-deploy.

## Configuration

`backend/.env` (gitignored). Key vars (see `.env.example` for the full list):

| Var | Notes |
|-----|-------|
| `DATABASE_URL` | Postgres. Composed from `PG_HOST`/`PG_PORT`/`PG_DATABASE`/`PG_USERNAME`/`PG_PASSWORD`/`PG_SSLMODE` at startup when unset (`config/env.ts`). |
| `PG_IAM_AUTH` | `true` → RDS IAM auth: Prisma runs through a node-postgres pool (`db.ts`, `driverAdapters`) whose password is a fresh IAM token per connection; region from `PG_IAM_REGION`/`AWS_REGION`/the RDS hostname; TLS verified against the baked RDS CA (`PG_SSL_CA_FILE`). Every module imports the shared `prisma` from `db.ts` — never `new PrismaClient()` elsewhere. |
| `DB_PUSH_MODE` | `additive` → `npm run db:push` runs `prisma db push` without `--accept-data-loss`: a change that would drop data-bearing columns or tables is logged and skipped (exit 0), so a rolled-back image can't drop a newer release's data. Unset keeps `--accept-data-loss`. The orchestrator's RDS cloud-init uses `additive` (`config/schemaSync.ts`) |
| `TERMAG_DATA_DIR` | default `/srv/termag`: where `npm run db:guard` looks for its marker files (`DATABASE_MOVED_TO_RDS`, `ALLOW_DOCKER_ROLLBACK`, `ALLOW_EMPTY_DATABASE`) |
| `SESSION_SECRET` | random hex |
| `AUTH_MODE` | `google` (default, in-app Google OAuth), `okta` (identity from the ALB `authenticate-oidc` edge via `x-amzn-oidc-data`), `oidc` (in-app OpenID Connect code flow, `auth/oidc.ts` — for the container behind a non-ALB ingress), or `local` (no identity provider, for the e2e stack only; see `BIND_HOST`). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth (required when `AUTH_MODE=google`) |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPE` | required when `AUTH_MODE=oidc`; redirect URI is `<FRONTEND_URL><BASE_PATH>/auth/oidc/callback` |
| `LOCAL_SESSIONS_ENABLED` | default `true`. `false` (baked into the container image) makes the in-process tmux fallbacks for box-less projects throw `LocalSessionsDisabledError` instead of hitting a non-existent tmux. |
| `BOX_PROVISIONER_ROLE_ARN` | optional; box-account role the provisioner assumes for every EC2/IAM call when the orchestrator's identity lives in another account (container). `HOST_SECURITY_GROUP_ID` is optional for the same reason. |
| `ALLOWED_USERS` | comma-separated `email:unixuser` pairs. Supports domain wildcards (e.g. `*@example.com:default-unixuser`). |
| `ADMIN_USERS` | optional; comma-separated emails or `@domain`s who may use the admin surface. Synced into `users.role` at startup (fail-closed when unset). |
| `SLACK_BOT_TOKEN` (`xoxb-`), `SLACK_APP_TOKEN` (`xapp-`), `SLACK_SIGNING_SECRET` | Slack Socket Mode |
| `CAPTURE_API_SECRET` | shared secret used by external pane-capture relays |
| `ORCHESTRATOR_LEASE` | `true` makes this process take part in overlapping deploys: the newest process holds `orchestrator_leases` and runs the sweeps; the displaced one drains (`/termag/health/serving` 503, new sockets closed 4503, then after `ORCHESTRATOR_DRAIN_GRACE_MS` its agents' sockets and `ORCHESTRATOR_DRAIN_BROWSER_DELAY_MS` later its browsers', all with 4503, which agents and the status socket redial at once). Slack Socket Mode and the Discord gateway connect only on the holder, a draining process stops the host's `claude-runner-orchestrator.service` (sudoers rule `deploy/claude-runner-orchestrator.sudoers`) and its runner spawn hook answers 503, and the new holder re-reads `session_statuses` once the old one has closed its sockets. Unset: always serving, as before. Never set it on a mirror that shares the production database |
| `AGENT_WS_QUERY_TOKEN` | default on. `false` refuses a box agent that sends its token as `/ws/agent?token=` instead of `Authorization: Bearer` (agents before the header did); the admin System page's "agent token in URL" line shows how many still do |
| `BIND_HOST` | interface the backend listens on; unset means all interfaces. `AUTH_MODE=local` refuses to start unless it is `127.0.0.1` or `::1` and `NODE_ENV` is `development` or `test` |
| `AWS_REGION` | region `boxProvisioner`'s EC2 and IAM clients talk to, and the boxes live in. Credentials are never configured by name: the SDK's default chain supplies them from the ambient identity (EC2 instance role, pod identity), optionally chained through `BOX_PROVISIONER_ROLE_ARN` |
| `BOX_RESOURCE_PREFIX`, `BOX_PERMISSIONS_BOUNDARY_ARN`, `BOX_VPC_ID`, `BOX_SUBNET_ID` | required, with `AWS_REGION` and `AGENT_WS_URL`, before a box can launch — `getBoxConfig` returns null without all six and the "Add box" path falls back to handing the user a token |
| `BOX_HIBERNATION_ENABLED`, `BOX_HIBERNATION_REFRESH_DAYS` | optional; `true` launches new boxes hibernation-capable when the AMI is tagged `Hibernation=supported` (default off); days hibernated before the sweep resumes and re-hibernates a box (default 55, `0` = never) |
| `BOX_INSTANCE_TYPE`, `BOX_MANAGED_TAG`, `BOX_ROOT_VOLUME_GB`, `BOX_GIT_TOKEN_SECRET_ARN` | optional; defaults are `t4g.medium` (the AMI is arm64-only), `termag-box`, and `120`. The AMI itself is discovered by tag, not configured |
| `TERMAG_FLAGS` | optional JSON object of flag key to value, e.g. `'{"warm-pool-enabled": true}'`; unset, every flag uses its built-in fallback. Served to the browser at `GET /api/flags`. |
| `PORT` | `3040` |

**PR pipeline and the running commit.** `GET /api/prs` (`routes/prs.ts`) returns the user's pull requests across the orgs in `GITHUB_REPO_ORGS` (all of GitHub when unset), already in lanes: three parallel GraphQL searches with the stored gh token (`services/prPipelineGithub.ts`; one combined query took ~7 s because `mergeable` is computed on demand), pure lane rules in `services/prPipeline.ts`, fresh for 60 s per user and then served stale while one reload runs (`swrMemo`, ceiling 10 min), `{ connected: false }` with no token. Lanes 1–2 (branches with no PR) come from the `git-branch-state` agent RPC (`agent/git-branch-state.js`, local refs only, no fetch), asked for every live workstream of the user's own projects inside that same load (`services/prBranches.ts`); its `origin` is also what links a PR row to a workstream by (repository, branch). A checkout with no GitHub origin never gets a branch row, and a branch that already had a PR merged (any age, one batched `pullRequests(headRefName:, states: MERGED)` query) is dropped, because a squash merge leaves it "ahead of base" for good. An agent that predates the RPC answers "Unknown command": its workstreams link by branch name only, and the response's `notes` say to restart it. "Deployed" is termag-only and asks GitHub `compare/{running}...{mergeCommit}` (cached forever per pair); a merge touching `agent/` or `deploy/` also needs every connected box's `agentCommit`, and a box GitHub cannot place (a public-mirror clone) is counted as unknown but does not hold a PR back. The dashboard's Pull requests section and the phone's `/m/prs` (inbox header link counts lanes 5 + 6) are read-only apart from Review with Devin, which is the Review button's `POST /api/projects/:id/review` against the row's `reviewTarget`. `GET /api/version` (`services/termagVersion.ts`) is what the orchestrator runs, resolved once at startup from `TERMAG_GIT_SHA`, else `git rev-parse HEAD` of its checkout, else `/opt/termag/.termag-baked-sha` (the bake deletes `.git`); an rsync-style hot-patch onto a baked host leaves that file stale, so set `TERMAG_GIT_SHA` when patching that way.

**Feature flags.** Optional and off-by-default: every flag read names a fallback, so with `TERMAG_FLAGS` unset the app runs on the fallbacks. `backend/src/services/featureFlags.ts` parses `TERMAG_FLAGS` and answers `boolVariation(key, user, fallback, box?)`; `routes/featureFlags.ts` serves the values at `GET /api/flags`. The frontend's `contexts/FeatureFlagsProvider.tsx` loads them before rendering, and `useFlag(key, fallback)` in `flags.ts` reads them. Flags in use: `warm-pool-enabled`, `repo-first-gate-enabled`, `repo-first-picker-enabled`, `box-auto-update-enabled`, `mobile-redirect-enabled`, `claude-cloud-sessions-ui` (all default off) and `hyperspace-background-enabled` (default on).

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

# build a box AMI
# automatic: merging to main bakes within the hour when box.pkr.hcl, setup.sh,
# agent/ or a shipped deploy/ file changed, or the image is over 14 days old
# (publish-ami.yml, `check-box-ami` job).
# on demand: GitHub → Actions → "Publish AMI" → Run workflow → target=box
# (or `both`) + tick `publish`; new boxes then pick up the newest Component=box
# AMI by tag. Without `publish` the result is a Component=box-candidate that
# discovery ignores -- bake a branch, inspect it, promote by retagging.
# local fallback (per-template init — `packer init .` errors on dup vars):
cd packer && packer init box.pkr.hcl && packer build box.pkr.hcl

# provision a box: the UI's New project dialog ("a new box…") is the only path
# the orchestrator knows about. boxProvisioner calls EC2 + IAM directly, so whatever a
# `terraform apply` in terraform/box/ creates has no Instance row behind it.

# run the orchestrator as a container (control plane only; boxes stay EC2)
docker build -t termag-orchestrator .
docker run --rm --env-file backend/.env termag-orchestrator npm --prefix backend run db:push   # schema sync
docker run --rm -p 3040:3040 --env-file backend/.env termag-orchestrator                       # serve
```

**Container deployment** — `Dockerfile` + `docs/container-deploy.md` (runtime contract: `/public/status` health, env, DB, auth modes, agent-endpoint requirements, single-replica constraint, EC2→container cutover runbook).

Apache snippet in `deploy/apache.conf`. See `deploy/setup.md` for the canonical first-time walkthrough (covers both Linux/systemd and macOS/launchd for the per-user agent); `deploy/claude-hooks.md` for the hook config; `docs/box-provisioning.md` for the orchestrator-driven box-provisioning design.

**Suburl apps on the orchestrator** — the orchestrator AMI ships an nginx gateway on :3040 that routes `/termag` to the backend (:3100) and any other path prefix to apps registered under `/srv/termag/apps/<name>/` (an nginx snippet + a systemd unit on the persistent volume, re-registered at every boot by `termag-apps-boot`). Never hand-create ALB target groups or listener rules for an app — see `docs/hosted-apps.md`.

**macOS note** — the per-user agent runs under `launchd` instead of `systemd --user`. There's no linger equivalent; the LaunchAgent plist (`~/Library/LaunchAgents/`) handles auto-start at login. See `deploy/setup.md` for the plist template and `launchctl` commands.

**Pre-commit** — a `gitleaks` hook is configured in `.pre-commit-config.yaml` with rules in `.gitleaks.toml`. Run `pre-commit install` once after cloning so leaked AWS / Slack / OAuth credentials get caught before they land in history.

## Testing

**Changes should ship with tests.** The backend runs [vitest](https://vitest.dev):

```bash
cd backend && npm test                       # vitest run — discovers src/**/*.test.ts
npm test -- src/auth/allowedUsers.test.ts    # one file
npm test -- -t 'domain wildcard'             # one test by name
npm run test:watch
```

**No linter or formatter is configured for the TS/JS here** — `npm run build` (`tsc`)
is the only static check on backend/frontend code. For `packer/**`, `terraform/box/**`
and `deploy/**` the checks are `packer validate` and the `deploy/*.test.sh` and `packer/scripts/*.test.sh` scripts.

There's no HTTP/DB integration harness, so prefer **extracting logic into pure,
side-effect-free modules** and unit-testing those — importing a route file like
`routes/projects.ts` directly drags in a module-level `PrismaClient` plus the
tmux/slack/agentRegistry imports. See `routes/bulkPin.ts` (+ `bulkPin.test.ts`)
and `auth/allowedUsers.ts` (+ `allowedUsers.test.ts`) for the pattern: the route
handler stays a thin wrapper, the testable logic lives in its own module. DB- and
side-effect-bound behavior is covered by manual verification until an integration
harness exists. The frontend has no test runner configured yet.

**End-to-end stack** — `make e2e-up` starts Postgres, the backend, the frontend and
two stand-in boxes (real `agent/agent.js`, temp homes, private tmux servers) under
one temp dir; `make e2e-down` removes it and `make e2e-test` scripts the whole
flow. Cursor cloud agents boot with it running. Use it to check UI and box-protocol
changes in a browser before a PR; real AWS is not covered, but box provisioning
(`E2E_EC2_LAUNCH`) and the warm pool (`E2E_WARM_POOL`, `scripts/e2e/warm-pool.test.sh`)
run against fakes. Opt-in fakes (`E2E_FAKE_AWS` via Floci, `E2E_FAKE_CLAUDE`, `E2E_FAKE_GITHUB`,
`E2E_TLS`, `E2E_SSHD`, `E2E_EC2_BOXES`, `E2E_EC2_LAUNCH`, `E2E_WARM_POOL`, `E2E_TMUX_FAULTS`) cover
what a feature needs beyond that, and `E2E_FLAGS` sets `TERMAG_FLAGS` for the stack
(`AUTH_MODE=local` only); extend them there rather than keeping one-off overlays.
Guide: [`docs/e2e-stack.md`](docs/e2e-stack.md).

## Observability & Maintenance

- Orchestrator logs can outlive the host: `termag-otelcol.service` ships the termag units' journal over OTLP/HTTP to `OBSERVABILITY_OTLP_ENDPOINT` under the routing key `OBSERVABILITY_PROJECT`. Filter on `service.name = termag-orchestrator` and `host.id` (the instance ID) or `host.image.id` (the AMI).
- `journalctl -u termag -f` — main server.
- `journalctl --user -u termag-agent -f` — per-user agent (run as the user).
- `tail -f /var/log/apache2/error.log` — proxy + WebSocket upgrade errors.
- Status events live in Postgres (`StatusEvent`) — usable for ad-hoc queries about agent activity.
- The agent process must be restarted whenever `agent/agent.js` changes (no hot reload). On a box, the orchestrator does that when it is safe (`deploy/termag-box-update`, started over the agent's `box-update` RPC once the `box-auto-update-enabled` flag is on for the box's owner and the box is behind the current image); a developer's checkout on a branch is left alone.

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
| `GET/POST/DELETE /termag/api/instances` | Box CRUD — list, provision (New project → "a new box…"; `kind: external` registers a self-managed host), decommission |
| `POST /termag/api/instances/:id/stop`, `/:id/start` | Stop / start an owned EC2 box; 202 with `stopping` / `starting` |
| `GET/POST/DELETE /termag/api/projects/:id/workstreams` | Workstream CRUD; agent RPCs manage the underlying git worktrees |
| `POST /termag/api/visits` / `GET /termag/api/visits/stats` | Project-visit ingest + stats for the UsageMini visits section |
| `GET /termag/api/warp/series` | Per-minute warp/flow-speed rollups for the UsageMini flow-speed section |
| `POST /termag/api/claude-runner/event` | A box reports on a cloud session it runs: `started` (session id, client platform; from `deploy/claude-runner-hooks/command`), `title` (once; from `termag-status prompt-submit`), `usage` (the session's cumulative tokens and model from its own transcript; from `termag-status stop` on every turn and once more from `post-session`; newest wins), `ended` (exit status and the reason `deploy/claude-runner-hooks/post-session` left for the wrapper's exit trap). Instance-bound agent token; the order's row must belong to that box |
| `GET /termag/api/claude-sessions?state=active\|recent` | The owner's Claude Code cloud sessions grouped from runs and events, with liveness from one `tmux-list` per box; `/:key/events`, `/:key/runner-log`, `POST /:key/end` (exact-name `tmux-kill`; the session parks on claude.ai, resumable). Owner only |
| `GET /termag/api/admin/claude-runner/health`, `/sessions` | Admin: the runner orchestrator's loopback `/healthz` (connected, queue counts; `CLAUDE_RUNNER_ORCHESTRATOR_HEALTH_PORT` names the port, unset = not on this host) and the org-wide cloud sessions without titles |
| `GET /termag/api/admin/...` | Admin-only org-wide reads: overview, fleet, users, projects, live sessions, token/worktime reports, signals, system; token/admin/audit management. 404 for non-admins |
| `POST /termag/mcp/admin` | Admin MCP server (Streamable HTTP, stateless); same queries as the REST routes, bearer `scope=admin` token or admin session |
| `WS /termag/ws/terminal/<sessionId>` | PTY stream (bidirectional) |
| `WS /termag/ws/status` | Status push fan-out — consumed by the UI and any opt-in external listener (idle-heartbeat keeps browser connections alive) |
| `WS /termag/ws/agent` | Per-user agent connection (bearer-token auth, dual-keyed by `instanceId`) |

**Slack `/t` commands** (in any channel the bot is in; auto-routes by channel — `#proj-<user>-<project>` is the project's `main` workstream, `#proj-<user>-<project>-<workstream>` is that workstream's tmux pair; legacy `#proj-<project>` still resolves, preferring the invoking user's project):

| Command | Effect |
|---------|--------|
| `/t` | Capture + post the active agent terminal |
| `/t <text>` | Send text to the agent terminal, poll for output |
| `/t !<keys>` | Send keystrokes without Enter (e.g. `/t !2` for numbered prompts) |
| `/t ctrl [...]` | Same, against the ctrl terminal |
| `/t create <name>` | New project + tmux sessions + Slack channel |
| `/t switch <project>[/<workstream>]` | Switch active target (used in DMs / non-project channels) |
| `/t attach <tmux-session>` | Capture a session by name; sets the matching project/workstream active |
| `/t projects`, `/t ls` | Listing helpers |

## Gotchas

1. **Per-user agent must be restarted on `agent/agent.js` changes** — no hot reload. On a box, `termag-box-update.service` (`deploy/termag-box-update --when-enabled`, started by the orchestrator over the agent's `box-update` RPC when the box is behind the current image, never by the box itself) first asks the orchestrator (`GET /api/box-update/policy`, the `box-auto-update-enabled` flag for the box's owner) and does nothing unless it says yes; when it does, it pulls `main`, reconciles and restarts the agent when a tracked `agent/` file or its unit is newer than the running process — but only on a clean `main`, only with `KillMode=process` loaded, and never while a Claude runner session is live; a developer's branch, and a box with `~/.config/termag/no-auto-update`, are left alone. Stage and dev boxes still restart by hand. Forgetting this leaves stale code running and is a common "why isn't my fix taking" debug detour.

2. **`loginctl enable-linger <user>` is mandatory (Linux)** — without it, the per-user agent stops the moment the user logs out, which makes everything in the UI hang the next time termag tries to talk to that user's agent. macOS uses launchd LaunchAgents instead and has no linger equivalent.

3. **`session` table is `connect-pg-simple`'s, but it IS declared in `schema.prisma`** — model `Session`, mapped to `session`, mirroring connect-pg-simple's `table.sql`. It is there purely so schema syncs (`prisma db push`, which drops unknown tables) create and keep it under the migration DB user; on a platform with a separate migration user the server's `application` user may not be allowed to `CREATE TABLE`, so `createTableIfMissing` in `backend/src/index.ts` is only a fallback. The app never touches the table through Prisma: don't add relations to it or query `prisma.session`.

4. **Slack scopes are large** — the bot needs `app_mentions:read`, `chat:write`, `channels:manage`, `channels:read`, `commands`, `im:history`, `im:read`, `im:write`, `files:read`, `reactions:read`, `reactions:write`, `users:read`, `users:read.email`. Re-add any you remove and reinstall the app or `/t create` will silently fail to create channels.

5. **WebSocket upgrade ordering in Apache** — `/termag/ws/*` ProxyPass MUST come before the plain `/termag/*` ProxyPass in the vhost, otherwise socket upgrades fall through to plain HTTP and the terminal never connects.

6. **`ALLOWED_USERS` maps email→unixuser** — both columns matter. A typo in the unixuser half doesn't fail OAuth; it fails later when the per-user agent can't be reached because no such systemd user service is running. Domain-wildcard entries (`*@example.com:default-unixuser`) match any email from that domain to the same unix user — handy, but it means a typo in the wildcard half silently routes everyone to the wrong account.

7. **Project working dirs may be symlinks** — when writing tooling that walks projects, `readlink -f` to get the canonical path before doing anything path-sensitive.

8. **Claude Code hooks fire `curl ... &` (background)** — the `&` is load-bearing. Without it, every tool use blocks on the localhost POST and feels visibly slower. Don't "clean up" the trailing `&` from `deploy/claude-hooks.md`.

9. **Codex bridge subprocess is owned by the per-user agent** — termag's main server doesn't manage it. If a Codex session looks dead, check the agent's logs (`journalctl --user -u termag-agent`), not the main server's.

10. **Provider registry lives in two files and must stay in sync** — `backend/src/providers/registry.ts` and `frontend/src/providers/registry.ts`. Adding a provider on one side only produces a project that the backend will accept but the UI can't render (or vice versa). There's no shared package; the symmetry is by hand. Each entry also carries `selectable`: only `true` entries (claude, cursor, devin, pi) appear in the create-project and default-agent pickers and pass the backend's new-choice validation (`SELECTABLE_PROVIDER_IDS`, `GET /api/providers`); `false` entries (codex, gemini, augment, deepseek, mistral, and the frontend-only `human`) are **hidden, never deleted**, because existing projects and historical worktime/token rows still render through them. `backend/src/providers/registry.test.ts` asserts the two files agree on ids, names, badges and `selectable`.

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

23. **EC2 security-group descriptions must be ASCII** — `terraform/box` had to swap an em-dash out of an SG description because EC2 rejects non-ASCII characters there. Anything you add to `main.tf` / `variables.tf` describing AWS resources should stay ASCII-only, and so must every description `boxProvisioner` sends with `CreateSecurityGroup` / `AuthorizeSecurityGroupIngress`.

24. **Boxes are provisioned per-Unix-user** — the Packer AMI ships with a `termag` default unix user, and cloud-init renames it to the project owner's username during provisioning. Don't hardcode `termag` as the unix user anywhere on the box; reference `$USER` or the value set by cloud-init.

25. **The box AMI is discovered by tag, not by id** — `boxProvisioner`'s `DescribeImages` call takes the newest self-owned image tagged `App=termag` + `Component=box`; no AMI id is configured anywhere. Rebuilding the AMI with Packer is enough to roll boxes forward, but a stale or missing tag fails the launch with `No box AMI found (tag App=termag, Component=box)`.

26. **Every project has a `main` workstream by default**. Tmux helpers and the agent runtime thread the workstream id through session naming, but legacy code paths that don't pass one will land on `main`. If you add a new code path that creates project artifacts (worktree, tmux session, status event), pass the workstream id explicitly rather than relying on the implicit `main`. Creating a non-`main` workstream auto-mirrors the project's main `Workflow` rows onto it and launches sessions; failures are returned as a non-fatal `sessionLaunchWarnings` array on the 201 response.

27. **`AUTH_MODE=local` is the only sign-in bypass, and it is loopback-only** — `/auth/login` signs in as the first `ALLOWED_USERS` identity (a `dev@<domain>` identity when there are only domain rules). `authRouter()` throws at startup unless `NODE_ENV` is `development` or `test` and `BIND_HOST` is `127.0.0.1` or `::1`, and `/auth/login` returns 403 unless the caller is on this host (`isSameHostRequest` in `auth/localLogin.ts`: a same-host nginx or Apache makes every socket peer loopback, so the gateway's peer header and forwarding headers are checked too). The old `/auth/dev-login` route, which any non-production server exposed, is gone; don't bring back a bypass that is gated on `NODE_ENV` alone.

28. **`routes/auth.ts` is the source of truth for sign-in modes** — `authMode()` defaults to `google` and only switches to `okta` (ALB header), `oidc` (in-app code flow) or `local` (e2e stack) when `AUTH_MODE` says so explicitly. `.env.example` describes all four, but read the code for behavior and the example for the variable list.

29. **The container has no local tmux — `LOCAL_SESSIONS_ENABLED=false`** — the in-process fallbacks in `services/tmux.ts` (used by `routes/projects.ts` / `services/agentRuntime.ts` only for projects with `instanceId == null`) throw `LocalSessionsDisabledError` there. A "legacy" project can therefore not be created or launched on a containerised orchestrator; pin it to a box. Don't "fix" this by installing tmux in the image — the container also has no engineer home directories or unix users.

30. **`~/.local/bin/xclip` is a termag shim, not X11 xclip** — the per-user agent installs `agent/xclip-shim.sh` there on Linux (idempotent, content-compared, on every startup) so Claude Code's Ctrl+V image paste has something to read on a box with no display. A browser paste sends the PNG over the terminal WebSocket, the agent writes `~/.cache/termag/clipboard.png` and only then types `\x16`. The shim answers exactly two invocations — `-t TARGETS -o` (prints `image/png`) and `-t image/png -o` (streams the file, then deletes it) — ignores a mailbox older than 60s, and fails like an empty clipboard for text and every other target. It shadows a real xclip if one is later apt-installed, since `~/.local/bin` usually precedes `/usr/bin` on `PATH`; rename or remove it if a box ever needs the real thing. `agent/xclip-shim.test.sh` covers the probe/read/staleness contract.

31. **`deploy/` is the source of truth, but only `termag-reconcile` makes it true on a running box** — nothing else installs `deploy/` onto the live paths outside an AMI bake, so a box whose checkout is current can still be *running* artifacts from the image it launched from. This is not hypothetical: a live box had the merged `KillMode=process` fix in `~/src/termag/deploy/termag-agent.service` while `~/.config/systemd/user/termag-agent.service` was the baked copy without it, and a 95-line `~/.local/bin/termag-status` that predated the endpoint-resolution fix — two merged fixes, neither in effect. `termag-reconcile.service` now content-compares and installs on every boot, ordered `Before=termag-agent.service` so the agent starts from the reconciled unit and nothing needs restarting. Between boots, `termag-box-update.service` (installed by the reconciler, so it reaches boxes that predate it; started by the orchestrator over the agent's `box-update` RPC when the box runs an older commit than the current box image, never by the box itself) runs `deploy/termag-box-update --when-enabled`, which does nothing until the orchestrator says the `box-auto-update-enabled` flag is on for the box's owner (`GET /api/box-update/policy`; no answer is a no, so the flag is the fleet-wide kill switch), and otherwise: `git pull --ff-only` on a clean `main`, `termag-reconcile --check` / reconcile / `--check`, `npm ci` in `agent/` when its lockfile changed, and the agent restart described under gotcha 1 — so a box left alone picks a merged `agent/` or `deploy/` change up once the orchestrator asks for it. The one-time catch-up for a box whose agent predates the `box-update` RPC is `git -C ~/src/termag pull --ff-only && ~/src/termag/deploy/termag-box-update` (pull, reconcile, restart the agent when safe), run as the box user with its systemd user bus in scope. There is no SSH to a box, but every provisioned box carries `AmazonSSMManagedInstanceCore` and a live SSM agent, so from an operator session in the termag account the catch-up is one Run Command, which needs neither a key nor the Session Manager plugin: `aws ssm send-command --document-name AWS-RunShellScript --targets Key=tag:App,Values=termag --parameters 'commands=["u=termag; sudo -u $u env XDG_RUNTIME_DIR=/run/user/$(id -u $u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u $u)/bus bash -lc \"git -C ~/src/termag pull --ff-only && ~/src/termag/deploy/termag-box-update\""]'`, then `aws ssm list-command-invocations --command-id <id> --details` for each box's stdout (one box: `--instance-ids i-…`). It is a one-off for boxes baked before the RPC, not a process: boxes from any later image are reached by the orchestrator's push, and the box reports its outcome (gotcha 47). The pull itself fails on a box whose git has no credential for the mirror; that is what the report's `pull=fetch-failed` says. If you add a box-side artifact to `deploy/`, add it to the table in `deploy/termag-reconcile` too, or it will only ever reach boxes through a bake. `claude-settings.json` is deliberately excluded because owners edit it; the reconciler only appends MetaTerm's three read-tool approvals to the installed `~/.claude/settings.json` and sets its own `mcpServers.metaterm` key in `~/.claude.json`, both with `jq`, never rewriting anything else. `termag-reconcile --check` reports drift without changing anything, which is the quickest way to tell whether a box is actually running what you think it is.

32. **First boot rewrites the baked `/home/termag` path from a bake-time index, and the index step must stay the last provisioner** — after step 2 renames the home (`mv`, then `usermod -l -d` to update the record), cloud-init fixes the symlink targets and text files that embed `/home/termag` by reading `/var/lib/termag-bake/home-paths/` and running `/usr/local/sbin/termag-rewrite-home-paths` (`packer/scripts/index-home-paths.sh` and `rewrite-home-paths.sh`). It used to find them at boot with `find -lname` over the whole home and `grep -rIl` over the toolchain dirs; on a box that walk hits a fresh EBS volume restored lazily from the snapshot, so every inode is an S3 round trip, and it took 4.5 minutes before the quick-start bake and 15.5 minutes after — past the orchestrator's 15-minute stuck-provisioning sweep — to rewrite about 200 symlinks and 3 files. Two consequences. Anything a provisioner writes under `/home/termag` *after* `index-home-paths.sh` runs is not rewritten at boot, so a new bake step that installs under the home goes before it in `box.pkr.hcl` (`packer/scripts/home-paths.test.sh` asserts the order). And the text-file scope is still the same six toolchain dirs (`.pyenv .goenv .nvm .local .cargo .config`, `SCAN_DIRS`); a file elsewhere that hardcodes the home, like the tilde-vs-absolute `~/.bazelrc` case above, is not covered — as it never was. The rename in step 2 is `mv` plus `usermod -l -d` **without `-m`** for the same reason: `-m` does the identical rename(2) and then stats every file under the home to re-own it (100,377 `newfstatat` for 100,003 files, measured), which was 4 more minutes on a quick-start box. Do not put `-m` back, and keep `box-ami-ci.yml`'s `sudo-handoff` job on the same sequence.

33. **`termag.service` runs `db:guard` before every start, and it can refuse** — `ExecStartPre` runs `backend/dist/scripts/dbGuard.js` (rules in `config/dbGuard.ts`). With a local database it refuses while `/srv/termag/DATABASE_MOVED_TO_RDS` exists (the RDS cutover wrote it; the container's copy is stale) unless `ALLOW_DOCKER_ROLLBACK` exists too, which `termag-rds-cutover rollback-to-docker` writes after copying Aurora back. On RDS (`PG_IAM_AUTH=true`) it refuses an empty or missing `users` table unless `ALLOW_EMPTY_DATABASE` exists, so an unrestored cluster never comes up as a blank termag that invalidates every box token. A termag that won't start after a database change: read `journalctl -u termag` for `[db:guard] REFUSED` before anything else.

34. **Theme settings are a JSON column validated by a module that exists twice** — `User.theme` is `jsonb` (`{}` = all defaults). `backend/src/theme/schema.ts` and `frontend/src/theme/schema.ts` are the same file kept in sync by hand, like the provider registry: the backend validates writes strictly (`validateTheme`, unknown keys rejected, the client sends the whole object so there is no server-side merge) and normalizes reads (`normalizeTheme`); the frontend normalizes again as a safety net. Adding a theme axis is a key, a default and a validator case in both copies, a CSS-variable mapping in `frontend/src/theme/apply.ts` and a group in `pages/settings/AppearanceSection.tsx` — no migration. The sidebar speed readout is no longer fed by the starfield's draw loop (`hooks/useEasedWarp.ts` steps it on a timer), so don't reintroduce an `onWarpChange` callback on `Hyperspace`: with a solid background or the hyperspace flag off the canvas is unmounted, and under reduced motion it draws one frame, so the readout would stick.

35. **Admin tokens are `agent_tokens` rows with `scope = 'admin'` and must never reach `/ws/agent`** — `registerAgent` replaces the agent for the same user/instance key, so a token that validated there would evict the user's real agent. `/ws/agent` and the gateway ext_authz checks accept only `scope = 'agent'`; `requireAuthOrAgentToken` (the agent-facing REST routes) and `cliBearer`'s `tmag_` path (`/api/cli/v1`) accept only `agent`; `requireAdmin` accepts only `admin` and re-checks that the owner is still an admin on every call. If you add a bearer-accepting route, decide which scope it takes — don't call `validateAgentToken` and ignore `result.token.scope`.

36. **Env-sourced admins are re-checked against `ADMIN_USERS` on every request; granted admins are not** — `isAdminUser` trusts `users.role = 'admin'` only when `adminSource = 'grant'`; a row with `adminSource = 'env'` must still match the live list. So a first-time sign-in on the list is an admin immediately, and removing an email demotes as soon as the process sees the new env (which, on the immutable-AMI orchestrator, means a restart — the startup sync also rewrites the row then). Env-listed admins cannot be demoted from the UI; edit the env. Granting admin to an env-listed user keeps `adminSource = 'env'` so the env stays authoritative for them.

37. **A cloud session's live status is keyed by the runner's tmux session name, not a project** — the session's Claude Code runs termag's status hooks, and the posts carry `<boxUser>-claude-runner-s<slot>-<order>-r`. `services/claudeSessions.ts` hands the frontend that name per run (`current.sessionName`) so it can read the same status map as a project pane. The ownership check in `routes/status.ts` admits those names for an instance-bound token only when they parse as runner sessions of that token's box (`isRunnerSessionOf`); a project pane under the box user's prefix is still refused.

38. **A session checkout's Bazel output base is removed by `termag-claude-runner`, by path hash** — Bazel keys the base on the MD5 of the workspace path under `~/.cache/bazel/_bazel_<user>/`, about 12 GB per checkout of a large Bazel repository, and nothing else ever removes it. The wrapper removes it (detached, after `chmod -R u+w`) when the checkout is released or kept, and sweeps bases whose workspace is gone at start, only when `DO_NOT_BUILD_HERE` names the checkout and `server/server.pid.txt` is dead. The shared `~/.cache/bazel-disk` and `~/.cache/bazel-repo-contents` are deliberately outside that root. Don't move them under it.

39. **The Review pane is a fifth session role, and the role list lives in six places** — `review` sits beside `agent`/`ctrl`/`data`/`data-ctrl` in `services/sessionAccess.ts` (`SESSION_ROLES`), `services/sessionResolver.ts`, `services/tmux.ts` (`sessionName`), the terminal-WS allowlist in `index.ts`, and the frontend `utils/sessionName.ts` + `services/api.ts`. Miss one and the pane either fails `assertSessionAccess` (400) or the browser's attach is refused as a session/project mismatch. The pane rides on the agent workflow: `agentRuntime.stopAgentSessions` kills it with the agent/ctrl pair (archive, workflow delete, workstream remove) and the rename route renames it, so a new teardown path that bypasses `stopAgentSessions` leaves Devin running unseen. Which PR a review pane is looking at is remembered only in backend memory (routes/review.ts and the review sweep); the tmux session is the durable thing, so after a backend restart the sweep's discovery reads the number back from the `@termag-review-pr` option or the launch echo, and a pane older than both ranges shows none. Starting a review uses only RPCs every deployed agent already has (`tmux-has-session/kill/create/send-keys`); the gh-based guess needs the newer `git-pr-info` RPC and falls back to the pane capture and milestone on an older agent — restart the per-user agent to get the branch-based guess. Devin is a poller provider, so the review pane has no live status; the pane's state is read off its bottom chrome instead (`classifyReviewPane`: approval footer → "needs an answer", Thinking line → "reviewing", bare prompt → "ready"). Since the review ring, that state is written ONLY by `services/reviewSweep.ts` (5 s sweep + tmux-list discovery) as `AgentStatus.review` on the AGENT session's status and pushed over /ws/status like `milestone` — never poll GET /review for it; the browser posts `POST /review/seen` when the review terminal takes focus while done, which clears the sidebar's ring. Shared viewers get the review without its URL, same as the milestone. Devin runs in `--permission-mode smart` because its default `auto` stops on the first `gh pr view` for approval; smart auto-runs safe commands **and** workspace edits, so the review staying read-only rests on the prompt's instruction — there is no per-session deny rule in Devin, only `~/.config/devin/config.json` and `.devin/config*.json` in the repo, neither of which termag writes.

## Related

**Other projects:**
- [agent-wiki](https://github.com/psecor/agent-wiki) — the docs spec this project's `AGENTS.md` follows; consumes nothing from termag at runtime

40. **Never build a shell string to type text into tmux — spawn `tmux` with an argv array** (`execFile('tmux', sendKeysArgv(...))`, builders in `agent/tmux-args.js` and `backend/src/services/tmux.ts`). The shell-string version single-quote-escaped the text *and* then ran it through `shellEscape`, so every `'` was typed as the four characters `'\''`: MetaTerm `send_keys`, Slack/Discord `/t` and the agent launch commands all went through it. Two tmux details that the builders encode: `--` must precede the text so a payload starting with `-` isn't parsed as a flag, and `-l` applies to every argument of one invocation, so in literal mode Enter is a separate `send-keys`. `tmux-capture` takes an opt-in `styled` flag (`capture-pane -e`) for callers that need to tell dimmed ghost-text from typed input; the default stays plain because the Slack/Discord formatters expect unstyled text.

41. **A provider that runs on boxes must post its own status, with a registered `source` — the tmux poller only sees the orchestrator's tmux** — `services/tmuxPoller.ts` reads local `capturePaneText`/`isAgentRunning` and never the agent RPCs, so poller providers (cursor, devin) have no live status on a box; and `services/status.ts` books a status whose `source` is unknown as Claude, so a hooks-style provider needs an entry in `statusSources` and must send it. pi is the worked example: its `launchCommand` runs `pi -e` with `deploy/pi-ext/termag-status.ts` (installed by termag-reconcile), a pi extension whose pure reducer (`termag-status-core.ts`, tested from `backend/src/providers/piStatusExtension.test.ts`) turns pi's lifecycle events into `termag-status … --source pi-ext:pi` calls; `termag-status` grew `--source/--reason/--message/--notify`, a `meta` mode and `--print-payload` for exactly this, while a plain `termag-status working` still sends the source-less payload the Claude hooks rely on. Three things that are deliberate: the registry's new `resumeCommand` (`claude --continue`, `pi --continue`) replaced the Claude-only relaunch special case in `agentRuntime.reconstructAgentSessions`; and a failed model request shows up as a `waiting` status with a `rateLimited` badge and a remedy naming the HTTP status. pi runs tools without approval prompts.

42. **`hibernated` is not `stopped`, and hibernation is fixed at launch** — EC2 only takes `HibernationOptions` on `RunInstances`, so `Instance.hibernationConfigured` is written once and every older box keeps plain Stop until it is replaced; the UI only offers Hibernate when it is true. Three things gate it: `BOX_HIBERNATION_ENABLED=true`, an AMI tagged `Hibernation=supported` (packer `var.hibernation`, default off, `scripts/enable-hibernation.sh`), and the type's `HibernationSupported`; the root then grows by the RAM size because hibinit-agent's swap file lives on it. Keep the two power-down statuses apart: a `stopped` box has lost its RAM and is the one a start may replace, a `hibernated` one must only be resumed. A hibernate EC2 refuses falls back to a plain stop with a note on the row, and the power sweep resumes and re-hibernates any box hibernated `BOX_HIBERNATION_REFRESH_DAYS` (55) because EC2 supports at most 60 (`docs/box-hibernation.md`).

43. **A stale box is asked to update by the orchestrator, behind `box-auto-update-enabled`, and "current" means the newest box AMI's commit** — `services/boxUpdate.ts` compares each connected owned box's `agentCommit` (the commit the agent process runs, from its hello; read once per process, so a checkout pulled without a restart still reports the old one) with the `TermagSha` tag of the newest published `Component=box` AMI, and sends the agent's `box-update` RPC (which starts `termag-box-update.service`, the same unit the box's six-hourly timer runs) when they differ: a minute after the hello and on a 30-minute sweep, leader work. The AMI tag is the target because `check-box-ami` in `publish-ami.yml` bakes a new box image exactly when `main` changed in a path that executes on a box, so there is no second copy of that path list and no GitHub credential on the orchestrator; the cost is the bake's lag (up to a few hours) and a harmless no-op push after an age-out rebake. One push per (box, target), in memory: a box that refuses the pull (a branch, a dirty tree, `~/.config/termag/no-auto-update`) is not asked again until the target moves. The flag's context is the owner + box multi-context (`boolVariation(key, user, fallback, box)`), so a rollout can start with one box. External boxes and agents without `box-update-v1` are skipped; the flag is read before the AMI, so a fleet with the flag off costs no `DescribeImages`. The push is the orchestrator's half; the box's half is one line back: `termag-box-update` posts `POST /api/box-update/report` at exit (instance token on stdin, a trap after the policy gate, so a policy no and `--check` post nothing), one word for the outcome — `failed` (any step failed, whatever the others did), `updated`, `deferred` (restart put off: a runner, `KillMode`), `skipped` (the pull refused: branch, dirty, detached), `current` — plus one token per step (`pull=pulled:3 reconcile=clean deps=unchanged agent=deferred:runner`, the vocabulary `parseBoxUpdateReport` accepts) and the commit before and after. The orchestrator logs it as one `[BOX-UPDATE] <box> (<owner>) reports …` line (shipped to Observability, where the box journal is not) and writes it on the box row (`last_update_*`), so the admin Fleet list shows a *last update* column and the System page counts boxes by the last outcome they reported in the day beside the target (`boxUpdates.boxesByLastOutcome24h`; a row keeps one report, so these are boxes, not runs); Signals raise `box_update_failed` (a `failed` within a week) and `box_update_deferred` (a `deferred` older than a day, unless the connected agent already runs the pulled commit: a reboot restarts the agent without a new report). The agent's hello also carries `agentCommitAt` (`git show -s --format=%cI HEAD`), so Fleet sorts boxes by how old their agent build is against the newest image's bake date, and the detail card says *Nd behind*. A wrapper from before the report posts nothing and the row says *never reported*; a box whose orchestrator predates the route logs `report: not posted … answered 404` and carries on.

44. **Host homes reach a new orchestrator only after the old one terminates, and nothing may touch a host account before that** — the host data volume (`/srv/termag`, `/home` bound from it) is attached after boot by `termag-data-attach.service`, which waits for the volume to be `available` (blue holds it until the ASG terminates it), mounts it, re-adopts the accounts and only then writes `/run/termag/host-storage-ready`. Until then `ensureHostSetup` mints nothing and `hostAgentUnavailableResponse` answers 503, and `deploy/termag-host-setup` exits 3 unless `findmnt` shows `/home` as the volume's bind: an account created on the root disk's `/home` takes a UID a volume home uses and vanishes under the mount. Keep both guards; a new path that creates host accounts or host tokens goes through `ensureHostSetup`. Three things are deliberate. The unit is `Type=simple`, never oneshot: its start job would hold `multi-user.target` and cloud-final, which starts the backend, so green would never serve and blue never release the volume. The script never detaches the volume from another instance, however long it waits; a stuck attach is the runbook's (confirm the holder is gone, snapshot, attach by hand, `systemctl restart termag-data-attach`). Nothing snapshots the volume on a schedule: the runbook takes a manual snapshot before the first handoff deploy and before any manual attach. And there are no fstab entries for the volume, because a boot that bound `/home` before the mount would bind an empty directory. The ASG is pinned to the volume's AZ for the same reason the volume can't follow it.
