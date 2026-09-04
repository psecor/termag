# Running the orchestrator as a container

The orchestrator (backend API + WebSockets, built frontend, Prisma tooling) can
run as a single container instead of a hand-built EC2 host. **Boxes stay EC2**:
the backend still provisions them with the AWS SDK; only the control plane
moves. This doc is the runtime contract for whatever schedules the container
(a Kubernetes deployment is the intended target) and the cutover runbook from
the EC2 host.

## Image

`Dockerfile` at the repo root, multi-stage, Node 20 on Debian slim. Runs as UID
10001 with nothing writable under `/app`; scratch goes to `/tmp`. Two targets:

| Target | Purpose |
|---|---|
| `runtime` (default) | the server: `tini -- node backend/dist/index.js` |
| `migrations` | same image plus a shim so a deploy platform whose migration step is hard-wired to `opentelemetry-instrument alembic upgrade head` ends up running `npm run db:push` (`backend/scripts/opentelemetry-instrument`) |

| | |
|---|---|
| Listens on | `PORT` (image default `3040`), HTTP + WebSocket on one port |
| App base path | `BASE_PATH` (default `/termag`; the frontend bundle is built for `/termag/`) |
| Liveness / readiness | `GET /public/status` → `200 {"status":"ok"}` (root-level, unauthenticated; a common default probe path). `GET /termag/health` is the same. |
| Schema sync | `npm --prefix backend run db:push` — `prisma db push --accept-data-loss --skip-generate` with the same connection resolution as the server, including IAM tokens. Run before the new server version starts. |
| TLS to Postgres | Amazon's RDS CA bundle is baked at `/app/certs/rds-global-bundle.pem` and used automatically (`PG_SSL_CA_FILE` overrides). |

Build locally with `docker build --target runtime .`; publish to whatever
registry your scheduler pulls from, tagged by short SHA.

## Environment

Everything in `backend/.env.example` still applies. What changes for a
container:

| Variable | Container value | Why |
|---|---|---|
| `LOCAL_SESSIONS_ENABLED` | `false` (baked into the image) | No tmux, no engineer homes. Legacy projects (no box) fail fast with an actionable error instead of ENOENT/EACCES. Every project must be pinned to a box or a self-managed agent. |
| `DATABASE_URL` **or** `PG_HOST`/`PG_PORT`/`PG_DATABASE`/`PG_USERNAME`(`PG_USER`)/`PG_PASSWORD`/`PG_SSLMODE` | either | Platforms that inject discrete `PG_*` variables work without a hand-written DSN; an explicit `DATABASE_URL` wins. |
| `PG_IAM_AUTH` | `true` on Aurora/RDS Proxy | No password: each connection authenticates with a 15-minute RDS IAM token minted for `PG_USERNAME`. Prisma runs through a node-postgres pool (`backend/src/db.ts`, `driverAdapters`); the session store shares the pool. Signing region: `PG_IAM_REGION`, else `AWS_REGION`, else parsed from the RDS hostname. |
| `AUTH_MODE` | `oidc` | See Authentication. |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPE` | from the Okta app | Required when `AUTH_MODE=oidc`. Redirect URI is `<FRONTEND_URL><BASE_PATH>/auth/oidc/callback`. |
| `FRONTEND_URL` | `https://<hostname>` | OAuth/OIDC callbacks, CORS. |
| `BOX_PROVISIONER_ROLE_ARN` | role in the **box** account | The container's identity lives in another account; every EC2/IAM call assumes this role first. Unset = ambient credentials (the EC2 instance-role shape). |
| `HOST_SECURITY_GROUP_ID` | **unset** | Only the EC2 host has a security group to punch `:3040` holes in. |
| `AGENT_WS_URL` | `wss://<hostname>/termag/ws/agent` | Baked into each box's `agent.config.json` at provisioning time. |
| `AWS_REGION`, `BOX_RESOURCE_PREFIX`, `BOX_PERMISSIONS_BOUNDARY_ARN`, `BOX_MANAGED_TAG`, `BOX_VPC_ID`, `BOX_SUBNET_ID`, `BOX_GIT_TOKEN_SECRET_ARN` | outputs of the `termag-box-provisioning` terraform module | Unchanged contract from the EC2 deployment; the module emits them as a `backend_env` map. |

connect-pg-simple's `session` table is declared in `schema.prisma` (model
`Session`) so the `db:push` step creates and keeps it under the `migration`
user; the server's `createTableIfMissing` is only a fallback for deployments
that never run `db:push`. No hand-run SQL step remains.

## Authentication

Three modes, selected by `AUTH_MODE`:

- `google` — in-app Google OAuth (default; local/dev).
- `okta` — identity from the AWS ALB `authenticate-oidc` action
  (`x-amzn-oidc-data`). Only valid behind such an ALB.
- `oidc` — the app runs the OpenID Connect authorization-code flow itself
  (PKCE, state, nonce; `backend/src/auth/oidc.ts`). Use this behind any ingress
  that has no browser auth action. Device
  trust (Kolide) is enforced by the Okta app's sign-on policy, so it carries
  over unchanged. `ALLOWED_USERS` remains the fine-grained gate in every mode.

Machine endpoints authenticate by bearer token: `/termag/ws/agent` (box agent
WebSocket) and `/termag/api/status` (status writes from agents and Codex
bridges). Any edge browser auth must let them through. The old same-host trust
for status writes never applies in a container (the socket peer is never
loopback), so those callers must present a token — which the shipped agent
already does.

## Networking requirements for the agent endpoint

- WebSocket upgrade on the same hostname/port as HTTP.
- Idle connections: the server pings every 25s; anything in the path (ALB, NLB,
  Envoy/Istio, nginx) must tolerate ≥60s idle or honour pings.
- Boxes need a route to the endpoint. Through the human hostname is simplest
  when boxes can resolve and reach it (VPC-internal DNS / VPN-equivalent
  routing); the token scopes each agent to one user's sessions.
- Outbound from the container: AWS STS/EC2/IAM (box account), the OIDC issuer,
  Slack (Socket Mode, if enabled).

## Single replica

Run exactly one replica. Agent WebSocket registry, terminal streams and the live
status map are in-process state; a second pod would split agents from the users
looking at them. Scaling out needs shared state or sticky routing first. Rolling
updates briefly run two pods — agents reconnect on their own (heartbeat-driven),
so the blip is seconds.

## What does not come along

- **Hosted suburl apps** on the EC2 host (`/srv/termag/apps/*` behind the nginx
  gateway; `docs/hosted-apps.md`). They are separate services living on that
  host's persistent volume and need their own home before the host goes.
- **Legacy on-host projects and shell accounts.** Users whose agent ran on the
  orchestrator itself (no box) must move to a box. Cleanest bridge: register the
  old host as a *self-managed* box in the new orchestrator and point its agent at
  the new `AGENT_WS_URL`; migrate projects at leisure.
- **Slack DM `claude` executor** (`backend/src/slack/executor.ts`) spawns the
  `claude` CLI on the orchestrator host. Not available in the container; the
  `/t` terminal flow (agent-routed) is unaffected.

## Cutover runbook (EC2 host → container)

1. **Stand up** the container with a fresh Postgres and the box-provisioning env
   from terraform. Confirm `/public/status`, sign-in, and an empty project list.
2. **Freeze** the EC2 orchestrator (`systemctl stop termag`), then copy data:
   `docker exec termag-pg pg_dump -U termag -Fc termag > termag.dump` on the
   host; `pg_restore --no-owner --clean --if-exists` into the new database (for
   Aurora IAM auth, connect as `migration` with a token from
   `aws rds generate-db-auth-token`); run `db:push` once against it to converge
   any drift.
3. **Re-point existing boxes.** Each box's `~/src/termag/agent/agent.config.json`
   still holds the old `ws://<private-dns>:3040/...` URL. Rewrite `termag_url`
   to the new `AGENT_WS_URL` and restart `termag-agent` — the provisioner role
   has `ssm:SendCommand` on `ManagedBy=$BOX_MANAGED_TAG` instances, so this is one
   `AWS-RunShellScript` fan-out. Tokens stay valid (they live in the migrated
   DB).
4. **Switch DNS / Okta redirect URI** to the new hostname if it changed; update
   `FRONTEND_URL` to match.
5. **Verify** end to end: sign in, open an existing project's terminal, add a
   box, terminate it.
6. **Decommission** the EC2 stack (terraform: remove the EC2 orchestrator module,
   ACM cert, alias record; keep or snapshot the EBS data volume until the hosted
   apps have moved). Then merge the repo cleanup that removes the orchestrator
   AMI pipeline.
