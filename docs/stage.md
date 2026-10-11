# Staging on a box

A termag that stays up on a box you already work on, run from one checkout,
with **the same tmux sessions, projects and agent CLIs your production termag
uses there**. It is where you click through a branch, or several at once,
before they are hot-patched onto the orchestrator.

```bash
make stage-up                                   # from the checkout to serve; idempotent
make stage-sync BRANCHES="feat-a feat-b"        # reset to origin/main, merge both, restart
make stage-sync                                 # again, with the same branches (after one landed)
make stage-add BRANCHES="feat-c"                # one more, without resetting
make stage-status  /  make stage-logs UNIT=backend ARGS=-f
make stage-restart                              # backend, frontend and agent
make stage-down                                 # stop; the database and checkout stay
bash scripts/stage/stage.sh seed                # projects + workstreams for this box's live sessions
bash scripts/stage/stage.sh reset-db            # empty database, re-register this box
bash scripts/stage/stage.sh uninstall --purge   # remove units, hook entries and the root
```

## What you get

| Piece | Where | Notes |
|-------|-------|-------|
| UI | `http://localhost:5190/termag/` | Vite dev server (hot reload) proxying to the backend. Forward this one port to your laptop and click **Sign in**. |
| Backend | `127.0.0.1:3070` | `tsx src/index.ts` from the checkout, `AUTH_MODE=local`, `LOCAL_SESSIONS_ENABLED=false`. |
| Postgres | `127.0.0.1:55470`, db `termag` | A private cluster under the root. It persists across restarts and reboots; the schema is converged with `prisma db push` before every backend start, data loss accepted. |
| Relay | `127.0.0.1:3071` | `scripts/e2e/box-network.mjs`: the agent and the hooks dial it, and it reaches the backend from `127.0.0.2`, so the backend sees this box as a box, not as itself (status from a loopback peer is filed under no box). |
| This box | an `external` instance named after the host | Registered once through `POST /api/instances`; the token lives in `agent.config.json` (0600) under the root and is never printed. |
| Mirror agent | `termag-stage-agent.service` | The checkout's `agent/agent.js`, run as you, in your HOME, against the staging backend. |
| Status feed | a line in `~/.config/termag/status-mirrors` | The box's `termag-status` posts every event to production and to each agent config listed there, so Claude hooks **and** pi's status extension reach staging, including panes already running. `down` removes the line, `up` restores it. If the installed `termag-status` predates mirrors, `up` falls back to adding a second Claude hook entry per event in `~/.claude/settings.json` (Claude only) and says so. |

Everything lives under `~/.termag-stage` (`STAGE_ROOT`): `stage.env` (what `up`
decided), `backend.env`, `logs/`, `pg/`, `branches` (what `sync` re-merges) and
`backend.local.env`, which you create for settings of your own (say
`ADMIN_USERS=...`); it is appended to `backend.env` on every `up`. The
processes are `systemd --user` units grouped under `termag-stage.target`, enabled
so they come back after a reboot (the box has lingering on for the agent).
Ports and the sign-in identity are `STAGE_*` variables read on `up`; see the
header of `scripts/stage/stage.sh`.

## The mirror

The production per-user agent on the box and the staging one are two
processes of the same unix user, so they share one tmux server and one
`~/termag/projects`. Session names are `<unixuser>-<project>-<role>`, and
the unix half of staging's `ALLOWED_USERS` is always the user running the
stack, so **a project created in staging with the name of one of your
production projects attaches to the very same sessions**: `tmux-create` reuses
an existing directory, repository and session, and the launch path probes the
pane before typing anything into it. Staging's database starts empty;
`bash scripts/stage/stage.sh seed` creates a project (and workstream) for every
live `<user>-<project>[-<workstream>]-agent` session on the box, resolved
against `~/termag/projects`, and is safe to rerun. Projects created by hand
appear in both UIs from then on too.
Both agents scrape panes for context and rate-limit warnings, and both
orchestrators receive every Claude hook event, so status pills agree. The
status route accepts the box's writes only through the relay (a loopback peer
is trusted as the orchestrator itself and attributed to no box), which is why
the agent config and the hook entries point at the relay port.

Things that follow from sharing:

- Anything you do in a staging terminal happens in the real session. Archive,
  terminate or rename a project in staging and the real tmux sessions are
  touched; the production database is not, so the two UIs then disagree until
  you repeat the action there.
- Restarting the staging agent is safe (`KillMode=process`, as in
  `deploy/termag-agent.service`): the tmux server is not in its cgroup.
- The mirror agent's config carries `"credentials": false`, so it advertises
  no credential capability and the staging backend never sends it
  `credentials-apply` or `credentials-remove` (which would otherwise undo the
  box's real gateway and GitHub broker setup, since those live in your
  HOME and `/etc`). As a second guard, `TERMAG_CLAUDE_SETTINGS` and
  `TERMAG_CLAUDE_MANAGED_SETTINGS` point under the root and
  `TERMAG_CREDENTIALS_SUDO` is empty.
- Workstreams mirror too: the agent's `git-worktree-add` reuses a worktree
  that already sits at `.worktrees/<name>` on the requested branch, so
  **Branch off** in staging with the name and branch of an existing workstream
  adopts it instead of failing.
- `agent/xclip-shim.sh` is installed to `~/.local/bin/xclip` by whichever
  agent started last, content-compared, so the two versions can differ only
  while a branch changes the shim.
- Slack, Discord and box provisioning are unset, so nothing double-posts or
  launches instances. Add them to `backend.local.env` only on purpose.

## Branches

Keep the staging checkout on an **integration branch** (`termag-stage`, say),
never on `main`: `sync` resets it hard to `origin/main` (`STAGE_BASE`) and
merges the branches you name, in order, with a merge commit each. A branch
that conflicts is skipped, reported, and the rest still go in; resolve it on
its own branch (or merge main into it) and `sync` again. The list is kept in
`branches` under the root, so after a PR lands `make stage-sync` with no
arguments rebuilds the stack from the new main and the remaining branches.
Branches are resolved locally first (the other worktrees of the same
repository), then on `origin`, so nothing has to be pushed to be staged.

`sync` and `add` refuse to run on a checkout with local changes: the
integration branch is disposable, your edits belong on the feature branches.
After merging, the backend, frontend and agent restart; the backend's
`ExecStartPre` regenerates the Prisma client when `schema.prisma` changed and
converges the database. A lockfile change triggers `npm ci`.

To see an edit without going through a branch, edit in the staging checkout
and `make stage-restart UNITS=backend` (the frontend hot-reloads on its own).

## Reaching it from your laptop

One port suffices. With SSM:

```bash
aws ssm start-session --region <region> --target <instance-id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["5190"],"localPortNumber":["5190"]}'
```

then `http://localhost:5190/termag/` and **Sign in**. The local login's
same-host check passes because the forwarded connection arrives from
loopback. Two termag UIs on `localhost` share the session cookie, so use a
separate browser profile for a second stack.

## Not covered

- **Other boxes.** `AUTH_MODE=local` requires the backend to bind loopback, so
  another box cannot reach this staging over the VPC without a tunnel or a
  TLS front; adding one is the next step when it is needed.
- **Production data.** This is not the orchestrator's `:3050` mirror, which
  shares the production database and forbids schema changes. Here schema
  changes are the point, and the data is yours to drop.
- **Google sign-in, Slack, the gateway.** Point `backend.local.env` at them
  if a branch needs them, or use the e2e stack's fakes ([e2e-stack.md](e2e-stack.md)).
