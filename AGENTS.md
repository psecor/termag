---
project: termag
status: production
status_description: 'Multi-user workspace orchestrator. Runs paired tmux sessions per project, web terminals via xterm.js + WebSocket, multi-provider agent choice (Codex, Claude, Mistral/vibe, Devin), Slack + Discord integration, project sharing with collaborators, two-tube thermometer UI tracking agent working time and human activity, pinned/recent-activity-sorted project list, on-demand EC2 box provisioning via the AWS SDK from a Packer-baked AMI ("Add box" button) with projects routed by `Instance`, per-project git-worktree workstreams (every project starts with `main`), and visit/flow-speed telemetry (ProjectVisit + WarpSample) surfaced in the usage overlay.'
last_updated: 2026-10-22
last_updated_by:
  - agent:claude-opus-4-6
  - agent:claude-opus-4-7
  - agent:sweeper-claude-opus-4-7
  - agent:claude-opus-5
  - agent:claude-opus-5-5
wiki_schema_version: 1
---

# AGENTS.md — termag

## What This Is

A multi-user workspace manager for running AI coding agents in parallel. Each project gets a paired set of tmux sessions — an **agent** pane (Codex, Claude Code, or other agents) and a **ctrl** pane (regular terminal for sudo / interactive auth / things the agent can't run). The web UI renders both terminals side-by-side with xterm.js, shows real-time agent status (working/waiting/idle from Claude hooks + Codex app-server), and exposes per-project usage and a Slack `/t` command surface.

Auth is Google OAuth with an `ALLOWED_USERS` allowlist mapping `email:unixuser`.

## Status

Production-ready. Provider registry covers Codex, Claude, Mistral (vibe), Devin, and pi (pi on the self-hosted model catalog); per-project working-time and human-activity tracking feed a two-tube thermometer UI; project sharing lets owners invite collaborators with terminal access; new projects get seeded `AGENTS.md` and `CLAUDE.md`. The orchestrator can now provision additional EC2 "boxes" on demand (the backend calls the AWS SDK to launch a Packer-baked AMI, surfaced as "a new box…" in the New project dialog) and route projects to a specific `Instance` via `Project.instanceId`. Every project carries a `main` workstream backed by a git worktree, with CRUD routes for additional workstreams. Visit + flow-speed telemetry (`ProjectVisit` for context switches, `WarpSample` for per-minute hyperspace-speed rollups) feeds new sections in the UsageMini overlay.

## Domain Model

The concepts the rest of this file and the code assume, one paragraph each, in [docs/agents/domain-model.md](docs/agents/domain-model.md): **Project**, **Paired tmux sessions**, **Workstream**, **Instance ("box")**, **Provider registry**, **Per-user agent process**, **Status events**, **Context-token warnings**, **Rate-limit detection**, **Working-time tracking**, **User segments (engagement ladder)**, **Human activity tracking**, **Project visit telemetry**, **Warp / flow-speed telemetry**, **Project sharing**, **Space**, **Automation**, **Admin surface**, **Agent-to-agent asks**, **Status WebSocket**.

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
│   ├── read-image.js               `read-image` RPC: an image file on the box as base64 (type by magic
│   │                                bytes, no SVG, 10 MiB cap) for the terminal's hover preview of image
│   │                                paths, served by GET /api/projects/:id/image (routes/sessions.ts)
│   ├── agent.config.example.json   sample per-user agent config
│   └── initial-AGENTS.md           template seeded into new projects on creation
├── relay/                          Chrome tab-capture relay (runs on user's laptop)
├── packer/                         AMI build for box images (Packer config + setup.sh)
├── terraform/
│   └── box/                        V1 Terraform shape of a box, reference only (boxProvisioner is the live path)
├── docs/
│   ├── agents/                     What this file indexes: domain model, data and schema, configuration,
│   │                               observability, integration surfaces, gotchas (each in full)
│   ├── box-provisioning.md         Design doc for orchestrator-driven box provisioning
│   ├── orchestrator-rds.md         The orchestrator's database on Aurora: design, cutover runbook
│   ├── hosted-apps.md              How to host extra apps on ALB suburls via the nginx gateway
│   ├── hosted-apps-migration.md    Moving those apps off the dev orchestrator host (status + plan)
│   ├── host-storage-handoff.md     How the host data volume moves to a new orchestrator; runbook
│   ├── project-migration.md        Design: moving a project and its workstreams between boxes
│   └── preview-share.md            Preview shares: a reviewer's sandboxed browser pane, no project access
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

`backend/prisma/schema.prisma` is the source of truth. The key models, their notable constraints and the recent migration history are in [docs/agents/data-and-schema.md](docs/agents/data-and-schema.md).

## Configuration

Every service's environment variables, which are secrets, and what differs between dev and prod: [docs/agents/configuration.md](docs/agents/configuration.md).

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

Where logs live, how to tail them, health checks and routine operations: [docs/agents/observability.md](docs/agents/observability.md).

## Integration Surfaces

The APIs, sockets and events other projects and boxes use, with payload shapes: [docs/agents/integration-surfaces.md](docs/agents/integration-surfaces.md).

## Gotchas

Read the matching entry in [docs/agents/gotchas.md](docs/agents/gotchas.md) before changing code in that area: each lede below is only the rule, not why it holds or what breaks.

1. Per-user agent must be restarted on `agent/agent.js` changes
2. `loginctl enable-linger <user>` is mandatory (Linux)
3. `session` table is `connect-pg-simple`'s, but it IS declared in `schema.prisma`
4. Slack scopes are large
5. WebSocket upgrade ordering in Apache
6. `ALLOWED_USERS` maps email→unixuser
7. Project working dirs may be symlinks
8. Claude Code hooks fire `curl ... &` (background)
9. Codex bridge subprocess is owned by the per-user agent
10. Provider registry lives in two files and must stay in sync
11. `agentProvider` is a string, not an enum
12. tmux poller patterns are provider-specific
13. Working-time attribution is per-provider source
14. Thermometers use an absolute 8h scale, not p50-relative
15. Project sharing routes terminal access through the *owner's* per-user agent
16. Context-token warnings are parsed from agent pane text, not a structured signal
17. Rate-limit detection is also pane-text parsing
18. Slack `/t` executor strips `ANTHROPIC_API_KEY` from the spawned env
19. Project-list ordering is `pinned DESC, lastActiveAt DESC`
20. Stale `waiting` status is auto-cleared by the per-user agent
21. Agent reconnect reconstructs sessions from the backend's view, not the agent's
22. `ensureAgentSessionsAndLaunch` probes before relaunching
23. EC2 security-group descriptions must be ASCII
24. Boxes are provisioned per-Unix-user
25. The box AMI is discovered by tag, not by id
26. Every project has a `main` workstream by default
27. `AUTH_MODE=local` is the only sign-in bypass, and it is loopback-only
28. `routes/auth.ts` is the source of truth for sign-in modes
29. The container has no local tmux — `LOCAL_SESSIONS_ENABLED=false`
30. `~/.local/bin/xclip` is a termag shim, not X11 xclip
31. `deploy/` is the source of truth, but only `termag-reconcile` makes it true on a running box
32. First boot rewrites the baked `/home/termag` path from a bake-time index, and the index step must stay the last provisioner
33. `termag.service` runs `db:guard` before every start, and it can refuse
34. Theme settings are a JSON column validated by a module that exists twice
35. Admin tokens are `agent_tokens` rows with `scope = 'admin'` and must never reach `/ws/agent`
36. Env-sourced admins are re-checked against `ADMIN_USERS` on every request; granted admins are not
37. A cloud session's live status is keyed by the runner's tmux session name, not a project
38. A session checkout's Bazel output base is removed by `termag-claude-runner`, by path hash
39. The Review pane is a fifth session role, and the role list lives in five places
40. An ask run has the box owner's full access, which is why asks are owner-only
41. Never build a shell string to type text into tmux — spawn `tmux` with an argv array
42. A provider that runs on boxes must post its own status, with a registered `source` — the tmux poller only sees the orchestrator's tmux
43. `hibernated` is not `stopped`, and hibernation is fixed at launch
44. A stale box is asked to update by the orchestrator, behind `box-auto-update-enabled`, and "current" means the newest box AMI's commit
45. Host homes reach a new orchestrator only after the old one terminates, and nothing may touch a host account before that
46. The daily briefing runs on the owner's box, never on the orchestrator, and is opt-in
47. A PR or commit made on a box is marked as termag's, and authorship is never touched
48. An agent spawn's brief is claimed by the first launch, by spawn id or child project id, never by name
49. A handoff types only fixed lines, and a restart's relaunch is claimed like a spawn's brief
50. New projects get a repo and an initial commit automatically, and the helper that does it lives in two files
51. The viewport zoom lock is the workspace's, not the phone's
52. A push subscription's endpoint is a URL the server POSTs to
53. `VAPID_SUBJECT` must be a public contact, or Apple refuses every push
54. Every agent telemetry resource carries the same four attributes
55. An automation run is a chat-runner turn, and only the relay or the timeout sweep may finish it
56. The browser pane's guest Chromium runs as `termag-guest`, and its sandbox is root's
57. The simple UI's side panel attaches the ctrl shell, never the agent pane, and shares its tmux window
58. A tab never starts the Okta login by itself; only a click or key press does
59. A desktop thread's status is filed by its checkout, not its tmux pane

## Related

**Other projects:**
- [agent-wiki](https://github.com/psecor/agent-wiki) — the docs spec this project's `AGENTS.md` follows; consumes nothing from termag at runtime

**Topics:**

**Moved out of this file** (each keeps the full text):
- [docs/agents/domain-model.md](docs/agents/domain-model.md)
- [docs/agents/data-and-schema.md](docs/agents/data-and-schema.md)
- [docs/agents/configuration.md](docs/agents/configuration.md)
- [docs/agents/observability.md](docs/agents/observability.md)
- [docs/agents/integration-surfaces.md](docs/agents/integration-surfaces.md)
- [docs/agents/gotchas.md](docs/agents/gotchas.md)
