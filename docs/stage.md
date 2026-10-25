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
STAGE_PROD_PROFILE=<aws-profile> bash scripts/stage/stage.sh refresh   # production's data, as a copy
bash scripts/stage/stage.sh refresh-schedule on # ...and again every day at 12:00 UTC
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

## Production data

`stage.sh refresh` replaces staging's database with a snapshot of
production's, so a frontend change can be looked at against real projects,
boxes, PRs and usage. Staging never connects to production: it gets a copy.
Schema branches, sweeps and clicks here touch nothing there, and the copy is
yours to break until the next refresh.

```bash
aws sso login --profile <aws-profile>
STAGE_PROD_PROFILE=<aws-profile> bash scripts/stage/stage.sh refresh   # the profile is kept in prod.env
bash scripts/stage/stage.sh refresh                                    # later runs
bash scripts/stage/stage.sh refresh --file <dump>                      # restore a dump you already have
bash scripts/stage/stage.sh refresh-schedule on [HH:MM] | off          # daily, UTC, default 12:00
```

How the snapshot travels (`scripts/stage/prod-snapshot.sh`). Production's
database is Aurora with IAM-token auth, reachable only from the orchestrator,
so nothing here dials it:

1. SSM Run Command runs `pg_dump` as root on the orchestrator, which already
   holds the host role's `rds-db:connect`. When the image's `pg_dump` is older
   than the server (it refuses newer servers), `scripts/stage/pg-tools.sh`
   unpacks the server's major from the PGDG apt repository into the dump's
   temp directory, without installing anything. It checks what apt would:
   the signed `InRelease` against PGDG's signing key (pinned by fingerprint,
   the same key Ubuntu's `postgresql-common` ships), the package index against
   `InRelease`, and each package against the index.
2. A one-shot server bound to the orchestrator's `127.0.0.1` serves the file
   once, under a random path, then deletes it (or after 15 minutes). The
   orchestrator is shared with other accounts; the random path is what keeps
   them out, so it lives in a root-only file, never in a command line (`ps`
   shows every account's).
3. This box pulls it through an SSM port forward, checks its sha256, and asks
   the orchestrator to clean up again.

Your SSO role needs `ssm:SendCommand` and `ssm:StartSession` on the
orchestrator, nothing on the database.

What the copy leaves out (rows only; every table's schema comes across): browser
sessions and CLI sign-ins (a copy would be a set of live session ids), agent
tokens, stored credentials (sealed with production's KMS key, unreadable here),
invite codes, production's orchestrator lease, and the queues staging's sweeps
would otherwise deliver a second time into this box's real panes: spawns,
handoffs, asks, collaboration requests. `STAGE_PROD_EXCLUDE_DATA` overrides
the list.

What `refresh` does with it:

- **Postgres version.** A dump from a newer major moves the staging cluster up
  first (re-created, not upgraded, since its data is being replaced). If that
  major is not installed, `pg-tools.sh` unpacks it under the root and the
  postgres unit runs it with `LD_LIBRARY_PATH`. The old data directory stays as
  `pg/data.<old major>`; a refresh that fails before the swap moves it back.
- **Swap.** The dump is restored into a side database and swapped in, so a
  failed restore leaves staging on its previous data. The previous database
  stays as `termag_prev` until the next refresh. The backend's start converges
  the copy to the checkout's schema, as on every start.
- **Sign-in.** Staging signs in as the snapshot's user with your unix name
  (`users.unixUsername` is unique, so any other email would collide with that
  row), and keeps that email for later runs.
- **This box.** The mirror agent is re-linked to the snapshot's record of this
  box (matched by short hostname), with a token minted in staging, so the box's
  projects come up live. Reconnecting recreates only sessions that are missing,
  as production does. A snapshot without this box registers a new one.
- **GitHub.** With a credential store configured (see `backend.local.env`),
  your `gh auth token -h github.com` is stored again as your staging GitHub
  credential, so the PR pipeline stays connected. `STAGE_PROD_GITHUB=0` skips it.
- **PR analytics ingest is off.** The snapshot names production's ingest token
  owner, often you, and with your token stored again staging would ingest the
  same repos on the same user's GitHub GraphQL quota (5,000 points an hour)
  as production does; on 2026-10-21 the two together exhausted it and the PR
  overview failed with "API rate limit already exceeded". The refresh clears
  `pr_analytics_settings.tokenUserId`, so the copied PR data stays browsable and
  the admin PRs tab says there is no token owner. Nominate one in staging's
  admin only for a short test, and clear it again afterwards.
- You sign in again afterwards: the copy has no sessions.

Everything else in the copy is as production had it, other people's data
included, so treat the root (`~/.termag-stage`, mode 0700) like production
data. Other boxes appear in their last production state but cannot be reached:
their agents talk to production.

The daily timer (`termag-stage-refresh.timer`) needs a live SSO session for the
profile. SSO sessions expire within a day, so an unattended run often finds
none: it fails, leaves the data it had, and says so on the `data` line of
`stage.sh status`. A refresh you run after `aws sso login` always works.

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
- **A live production database.** This is not the orchestrator's `:3050`
  mirror, which shared the production database and forbade schema changes.
  Production data arrives here only as a copy (above): schema changes are the
  point, and the data is yours to drop.
- **Google sign-in, Slack, the gateway.** Point `backend.local.env` at them
  if a branch needs them, or use the e2e stack's fakes ([e2e-stack.md](e2e-stack.md)).
