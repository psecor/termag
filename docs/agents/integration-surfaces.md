# Integration surfaces

Moved out of [AGENTS.md](../../AGENTS.md), which keeps a short index of it. Paths are from the repository root.

**HTTP / WebSocket** (selected):

| Endpoint | Purpose |
|----------|---------|
| `GET /termag/api/projects` | List projects (own + shared) |
| `POST /termag/api/projects` | Create project (also creates tmux sessions, Slack channel, seeds AGENTS.md + CLAUDE.md, creates `main` workstream) |
| `POST /termag/api/status` | Status update from Claude hooks / Codex bridge — primary write path |
| `GET /termag/api/usage/...` | Token + cost rollups for the dashboard (provider-specific scanners) |
| `GET /termag/api/worktime` | Working-time rollups by provider (agent + human), derived from `StatusEvent` and heartbeats; thermometers use an absolute 8h scale |
| `POST /termag/api/status/heartbeat` | Human activity heartbeat from the UI (fires every 30s while typing); 3-min decay banks to `work_time_entries` with `provider: "human"` |
| `POST /termag/api/projects/:id/invite` | Invite a collaborator by email (403 `sharing_disabled` while `box-sharing-enabled` is off for the inviter) |
| `GET /termag/api/invites` | List pending invites for the logged-in user |
| `POST /termag/api/invites/:id/accept` | Accept a project invite (403 `sharing_disabled` while `box-sharing-enabled` is off for the invitee) |
| `DELETE /termag/api/projects/:id/shares/:shareId` | Revoke a collaborator's access |
| `GET/POST/DELETE /termag/api/instances` | Box CRUD — list, provision (New project → "a new box…"; `kind: external` registers a self-managed host), decommission |
| `POST /termag/api/instances/:id/stop`, `/:id/start` | Stop / start an owned EC2 box; 202 with `stopping` / `starting` |
| `POST /termag/api/instances/:id/rename` | Rename an owned box `{ name }`; 409 when another live box of the owner has it, 403 `rename_disabled` while `box-rename-enabled` is off. The CLI's is `POST /termag/api/cli/v1/boxes/:id/rename` |
| `GET/POST/DELETE /termag/api/projects/:id/workstreams` | Workstream CRUD; agent RPCs manage the underlying git worktrees |
| `POST /termag/api/cli/v1/projects/:id/workstreams`, `DELETE …/projects/:id/workstreams/:name` | The CLI's twins (`routes/cliLifecycle.ts`, the same `createWorkstreamFor` / `removeWorkstreamFor`): `{ name, base?, agent?, startFromOrigin? }` answers the worktree's directory as the box sees it; `DELETE { force?, keepBranch? }`. Owner only, any CLI credential. The termag desktop app's New worktree (`agent: claude-chat`). Like `POST …/projects/:id/clone/retry` and `POST …/boxes/:id/hibernate`, behind `desktop-app-enabled` (off: 404 `not_found`) |
| `POST /termag/api/visits` / `GET /termag/api/visits/stats` | Project-visit ingest + stats for the UsageMini visits section |
| `GET /termag/api/warp/series` | Per-minute warp/flow-speed rollups for the UsageMini flow-speed section |
| `POST /termag/api/claude-runner/event` | A box reports on a cloud session it runs: `started` (session id, client platform; from `deploy/claude-runner-hooks/command`), `title` (once; from `termag-status prompt-submit`), `usage` (the session's cumulative tokens and model from its own transcript; from `termag-status stop` on every turn and once more from `post-session`; newest wins), `ended` (exit status and the reason `deploy/claude-runner-hooks/post-session` left for the wrapper's exit trap). Instance-bound agent token; the order's row must belong to that box |
| `GET /termag/api/claude-sessions?state=active\|recent` | The owner's Claude Code cloud sessions grouped from runs and events, with liveness from one `tmux-list` per box; `/:key/events`, `/:key/runner-log`, `POST /:key/end` (exact-name `tmux-kill`; the session parks on claude.ai, resumable). Owner only |
| `GET /termag/api/admin/claude-runner/health`, `/sessions` | Admin: the runner orchestrator's loopback `/healthz` (connected, queue counts; `CLAUDE_RUNNER_ORCHESTRATOR_HEALTH_PORT` names the port, unset = not on this host) and the org-wide cloud sessions without titles |
| `GET /termag/api/admin/...` | Admin-only org-wide reads: overview, fleet, users, projects, live sessions, token/worktime reports, signals, system; token/admin/audit management. 404 for non-admins. Also `GET /api/admin/segments` (engagement-ladder daily buckets + 7-day flows + tracker health), `/segments/users?date=`, `POST /segments/rebuild` (session write). |
| `POST /termag/mcp/admin` | Admin MCP server (Streamable HTTP, stateless); same queries as the REST routes, bearer `scope=admin` token or admin session |
| `POST /termag/api/spawns`, `GET /termag/api/spawns?session=`, `POST /termag/api/spawns/report`, `GET /termag/api/spawns/budget`, `GET /termag/api/spawns/usage` (the dashboard's Agents section), `GET /termag/api/spawns/trees/:rootId` (one tree for the network view), `GET /termag/api/spawns/sessions/:projectId/:workstream/trees` (every tree one session started) | Agent spawn: a box agent starts another agent on a brief in a new workstream or project, lists its children, and a child reports back. Box token or session; behind `agent-spawn-enabled` |
| `POST /termag/api/projects/:id/workstreams/:wsId/handoff`, `POST /termag/api/handoffs`, `POST /termag/api/handoffs/:id/written`, `POST /termag/api/handoffs/:id/abort` | Agent handoff: a person (cookie) or the agent itself (box token, MetaTerm `handoff`) asks for one; the agent's handoff comes back through `handoff_written`; the leader's sweep then clears, compacts or restarts the pane. Owner only; behind `agent-handoff-enabled`. The CLI and TUI use `POST /termag/api/cli/v1/projects/:id/handoff` and `GET …/cli/v1/handoffs/:id` |
| `WS /termag/ws/terminal/<sessionId>` | PTY stream (bidirectional) |
| `WS /termag/ws/status` | Status push fan-out — consumed by the UI and any opt-in external listener (idle-heartbeat keeps browser connections alive) |
| `WS /termag/ws/browser?projectId=&workstream=&url=&width=&height=` | Browser pane: JPEG frames from a headless Chromium on the project's box, input events back; session cookie + owner/share authz, 4403 while `browser-pane-enabled` is off for the viewer and box, 4501 when the agent lacks `browser-pane-v1` |
| `WS /termag/ws/browser?share=&url=&at=&width=&height=[&as=guest]` | A reviewer's guest pane: the share, never the project, admits the viewer (`services/previewShareRules.ts` `resolveGuestAccess`; anyone it isn't for gets the same 4410 `not-shared`), and the agent runs a guest browser kept to the share's origins (`browser-pane-guest-v1`). Owner and box flags `browser-pane-enabled` + `browser-pane-preview-share-enabled`, the kill switch `browser-pane-guest-kill-switch` (4403), a parked box 4409 "<owner>'s box is asleep" (a guest never wakes it), the agent's `guest-*` refusals mapped (4429 busy redials; 4424 stack, 4500 canary, 4501 final). Extra frames down: `blocked {origin, local}`, `checkout {branch, head, dirty}`. Every live guest socket re-checks its grant every 30 s and at expiry; a revoke on this process closes it at once. `as=guest` lets the owner preview their own share |
| `POST/GET /termag/api/projects/:id/preview-shares`, `PATCH/DELETE …/:shareId`, `GET /termag/api/preview-shares[/:shareId]`, `POST …/:shareId/ask-wake` | Preview shares (`routes/previewShares.ts`): owner creates (a named termag user by email, a workstream, a recipe, a lifetime from `browser-pane-preview-share-ttl-hours`, 1..168 h), lists, extends, revokes (scoped by both ids; closes live guests and has the box forget their profiles); the grantee lists theirs and reads one (its state, or the same 404 for anyone else) and asks the owner on Slack to wake the box. Session cookie only |
| `GET /termag/p/:key[?at=<path>]` | The share link: signs the visitor in and back (`auth/postLoginReturn.ts`), then the guest page `/termag/preview/:key` (the owner or a full collaborator: their own workspace pane, `?project=&ws=&browser=open&browserShare=&browserAt=`, whose first dial carries `openShare=&at=` so the agent opens the share's app). `at` is a path only (`safeAtPath`) |
| `POST /termag/api/cli/v1/ask`, `GET …/ask/messages/:id?wait=`, `GET …/ask/inbox` | Agent-to-agent asks: start or continue a thread (202), long-poll a message (the reply goes only to a waiting poll; never stored), list the last day's asks and what became of each reply. Any CLI credential |
| `PUT …/ask/runs/:id/bundle`, `POST …/ask/runs/:id/result` | The target box returns an ask run's commits (raw `git bundle`, ≤ 25 MB) and its result. Box credential of the message's box only |
| `WS /termag/ws/agent` | Per-user agent connection (bearer-token auth, dual-keyed by `instanceId`) |

**Slack `/t` commands** (in any channel the bot is in; auto-routes by channel — `#proj-<user>-<project>` is the project's `main` workstream, `#proj-<user>-<project>-<workstream>` is that workstream's tmux pair; legacy `#proj-<project>` still resolves, preferring the invoking user's project):

| Command | Effect |
|---------|--------|
| `/t` | Capture + post the active agent terminal |
| `/t <text>` | Send text to the agent terminal, poll for output |
| `/t !<keys>` | Send keystrokes without Enter (e.g. `/t !2` for numbered prompts) |
| `/t -- <text>` | Send the text as written, with Enter: a command word or a leading `!` is text (`—` works too) |
| `/t help [<command>]` | The commands, or one in detail; ephemeral (`slack/slashCommand.ts`) |
| `/t ctrl [...]` | Same, against the ctrl terminal |
| `/t handoff [clear\|compact\|restart] [agent]` | Hand the agent off: it writes a handoff, then its context is reset or the pane restarts (naming an agent restarts on it) |
| `/t create <name>` | New project + tmux sessions + Slack channel |
| `/t switch <project>[/<workstream>]` | Switch active target (used in DMs / non-project channels); saved in `chat_active_targets`, so it survives deploys |
| `/t attach <tmux-session>` | Capture a session by name; sets the matching project/workstream active |
| `/t projects`, `/t ls` | Listing helpers (`projects`: owned and shared; `ls`: the tmux sessions on each of the caller's connected boxes, then their per-user agent) |

A command word counts only in the forms above, in any casing (`parseSlashCommand`); anything else goes to the agent, so `/t projects ls` types `projects ls`, and a command word without its argument shows its help. Errors, refusals and help are ephemeral (`respond`); panes, listings and confirmations post to the channel. A refused `/t`, DM or @mention gets an ephemeral pointer to #termag-help (`slackRefusalText` in `slack/access.ts`; DMs and @mentions once per rate-limit window).
