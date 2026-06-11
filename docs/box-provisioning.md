# Orchestrator-driven box provisioning ("Add box" button)

**Status:** design / not yet implemented

## Goal

Add an **Add box** button to the orchestrator UI that bootstraps a new EC2
compute instance via the AWS SDK and attaches it to the requesting user as an
agent — replacing today's V1 flow where the user runs `terraform apply`
themselves.

## Background: what already exists

This feature is the natural completion of the box-CRUD that is currently
stubbed as "user-driven Terraform." Most of the skeleton is already present.

| Layer | File | State |
|-------|------|-------|
| Backend CRUD | `backend/src/routes/instances.ts` | `POST` creates an `Instance` row (`status: provisioning`) + a per-box `AgentToken` atomically and returns the raw `tmag_` token once. `DELETE` archives projects, revokes tokens, marks `terminated`. Both currently expect the *user* to run terraform. |
| Agent registry | `backend/src/services/agentRegistry.ts` | Dual-keyed (`instanceAgents` by `instanceId`). When a box dials `wss://<host>/termag/ws/agent?token=…`, `validateAgentToken` resolves token→`{user, instance}` and `registerAgent` flips the Instance to `ready` and reconstructs its sessions. **Needs no changes.** |
| WS auth | `backend/src/index.ts` (`/ws/agent`) | `validateAgentToken` (in `routes/agentTokens.ts`) looks up `tokenHash`, returns `{user, instance}`. **Needs no changes.** |
| Box shape (reference) | `terraform/box/` | V1 Terraform: egress-only SG, IMDSv2 instance, `cloudinit.sh.tftpl` that writes `agent.config.json {termag_url, token, path_remap}` and starts the agent systemd user unit. |
| Box AMI | `packer/` | Prebakes repo, agent CLIs, `termag` user + linger, the `termag-agent.service` unit. |
| Guardrails | Your IAM-grant Terraform | IAM grant + outputs (`box_resource_prefix`, `box_permissions_boundary_arn`, `box_managed_tag`, `agent_ws_url`) built specifically so the orchestrator can launch boxes via the SDK within a locked blast radius. |

**The missing piece is the bridge:** a backend service that, instead of handing
the user a token to paste into Terraform, calls the AWS SDK itself to launch the
box. The frontend has **zero** box UI today (no button, no `instancesApi`).

## Design decisions

1. **Box token delivery:** baked into `user_data` (inline), matching the
   existing `terraform/box/cloudinit.sh.tftpl`. (See Security below — this is no
   weaker than the `agent.config.json` the agent must read anyway.)
2. **Box IAM identity:** a **per-box role with the permissions boundary**, as
   the 0.3.0 grant enforces (`iam:CreateRole` is denied without the boundary).
3. **AMI selection:** **discover newest by tag** (`App=termag, Component=box`),
   so no redeploy is needed when a new AMI is baked.

## Architecture

The button `POST`s to the existing `POST /api/instances`. The endpoint keeps
doing its DB + token work, then kicks off **async** AWS provisioning and returns
immediately with `status: provisioning`. The box boots, cloud-init starts the
agent, the agent dials in, and `registerAgent` flips it to `ready` — the UI
just polls/streams that status. No request blocks on a multi-minute EC2 boot.

```
[Add box] → POST /api/instances
              ├─ tx: create Instance(provisioning) + AgentToken (existing)
              └─ provisionBox(...)  (async, not awaited)
                    ├─ DescribeImages  (newest App=termag,Component=box)
                    ├─ CreateSecurityGroup  (egress-only, ManagedBy tag)
                    ├─ AuthorizeSecurityGroupIngress on ALB SG (443 from box SG)
                    ├─ CreateRole(+boundary) → AttachRolePolicy SSM core → InstanceProfile
                    └─ RunInstances  (AMI, arm64 type, subnet, SG, profile,
                                      IMDSv2, tags, user_data=cloud-init+token)
                          ↓ EC2 boots, cloud-init starts agent
                          ↓ agent dials wss://<host>/termag/ws/agent?token=…
                       registerAgent → Instance.status = ready
```

## Backend changes (`termag/`)

### New: `backend/src/services/boxProvisioner.ts`

Uses `@aws-sdk/client-ec2` + `@aws-sdk/client-iam`.

`provisionBox({ instance, boxName, owner, token, remoteUnixUser })`:
1. `DescribeImages` filtered `tag:App=termag, tag:Component=box`, sort by
   `CreationDate`, take newest → `amiId`.
2. `CreateSecurityGroup` `<BOX_RESOURCE_PREFIX>-<box>` in `BOX_VPC_ID`,
   egress-only, tag-on-create `ManagedBy=$BOX_MANAGED_TAG` + `Owner`/`BoxName`.
3. `AuthorizeSecurityGroupIngress` on `ALB_SECURITY_GROUP_ID`: 443 from the new
   box SG (grant's `Ec2BoxIngressToAlb`).
4. Per-box IAM: `CreateRole` `<BOX_RESOURCE_PREFIX>-<box>` **with
   `PermissionsBoundary=BOX_PERMISSIONS_BOUNDARY_ARN`** (denied otherwise);
   `AttachRolePolicy` `AmazonSSMManagedInstanceCore`; if
   `BOX_GIT_TOKEN_SECRET_ARN` set, add an inline read policy for just that ARN;
   `CreateInstanceProfile` + `AddRoleToInstanceProfile`.
5. `RunInstances`: `amiId`, `BOX_INSTANCE_TYPE` (**must be arm64/Graviton** — the
   AMI is arm64-only), `BOX_SUBNET_ID`, box SG, instance profile, IMDSv2
   required, `TagSpecifications` (`Name=<prefix>-<box>`, `ManagedBy`, `Owner`,
   `BoxName`), `UserData` = base64 of a TS port of `cloudinit.sh.tftpl` with the
   token inlined and `termag_url=AGENT_WS_URL`.
6. Persist `ec2InstanceId`, `region`, `hostname`, `securityGroupId`,
   `iamRoleName`.

`terminateBox(instance)`: `TerminateInstances` (tag-scoped) → revoke the ALB
ingress rule → delete SG (after the instance is gone) → detach/delete role +
instance profile. (No secret to delete, since the token lives in `user_data`.)

**Cloud-init port:** copy from `terraform/box/cloudinit.sh.tftpl`, **not** from
packer's comment. The baked `termag-agent.service` runs
`agent.js <home>/src/termag/agent/agent.config.json` (argv), so the config must
land at `~termag/src/termag/agent/agent.config.json` — which is what the
`terraform/box` template does. (packer's `setup.sh` comment claiming
`~/.config/termag/agent.config.json` is stale/wrong; see Known issues.)

### `backend/src/routes/instances.ts`

- `create`: after the existing `$transaction`, fire `provisionBox(...)`
  un-awaited (returns `provisioning` instantly; on `RunInstances` error set
  `status: failed` + the new `provisioningError` column).
- `terminate`: call `terminateBox` (actually destroy the EC2) instead of the
  "run `terraform destroy`" hint.
- Add a stuck-`provisioning` sweep → `failed` after N minutes with no agent.

### `backend/prisma/schema.prisma`

`Instance` gains `securityGroupId String?`, `iamRoleName String?`,
`provisioningError String?`; `status` now also takes `failed`. Picked up by the
existing `prisma db push` in cloud-init.

### `backend/.env` (via the module's Secrets Manager secret)

`AWS_REGION`, `AGENT_WS_URL`, `BOX_RESOURCE_PREFIX`,
`BOX_PERMISSIONS_BOUNDARY_ARN`, `BOX_VPC_ID`, `BOX_SUBNET_ID`,
`BOX_INSTANCE_TYPE`, `ALB_SECURITY_GROUP_ID`, optional
`BOX_GIT_TOKEN_SECRET_ARN`. Most are already module outputs.

## Frontend changes (`termag/`)

- `instancesApi` (list/get/create/terminate) in `frontend/src/services/api.ts`.
- A **Boxes** sidebar section in `App.tsx` with the **Add box** button → name
  modal → `POST` → optimistic row with a `provisioning` spinner that resolves to
  `ready`/`failed` on poll. Terminate via the existing 409-confirm flow.
- An instance picker in project-create (`Project.instanceId` already exists).
- Mirror the existing project-tile patterns.

## Terraform changes

The 0.3.0 grant already covers every SDK call above (`DescribeImages`,
`CreateSecurityGroup`+tag, `Ec2BoxIngressToAlb`, `CreateRole`-with-boundary,
`AttachRolePolicy`→SSM, instance-profile, `RunInstances`, `PassRole`,
tag-scoped `TerminateInstances`). The module side is mostly **surfacing outputs
into the `.env`** — the consumer's `termag.tf` should feed `box_resource_prefix`,
`box_permissions_boundary_arn`, `alb_security_group_id`, the VPC/subnet, and
`agent_ws_url` into the secret payload (today the secret is populated
out-of-band for OAuth only).

## How `packer/` and `terraform/box/` fit

- **`packer/` is load-bearing — keep it.** It builds the AMI that "discover
  newest by tag" finds and that `RunInstances` boots. It prebakes everything
  slow/stable: system packages, AWS CLI v2, Node LTS, `gh`, the `termag` user
  **with linger**, the agent CLIs (claude/cursor/devin), the repo clone at
  `~termag/src/termag` + the agent's `npm install`, and the
  `termag-agent.service` user unit. The SDK only injects per-box runtime config
  on top.
  - The **tag contract is now an API** — don't change `App=termag,
    Component=box` casually.
  - AMI is **arm64-only** → `BOX_INSTANCE_TYPE` must be Graviton.
  - packer defaults clone `psecor/termag`; point it at the deployed fork/ref.
  - Today it's a manual `packer build`; eventually automate rebuilds so the
    newest-by-tag AMI tracks master.

- **`terraform/box/` is the spec, then vestigial.** Everything it declares is
  what `boxProvisioner` re-creates via the SDK; its `cloudinit.sh.tftpl` is the
  reference we port to TS. Its IAM choice (shared
  `AmazonSSMRoleForInstancesQuickSetup`) is **superseded** by the
  per-box-role+boundary decision. Recommendation: keep it through
  implementation as the cloud-init reference + a break-glass manual path, then
  **delete it** once the button flow is proven — a standalone terraform-managed
  box is redundant once box lifecycle is owned by the termag backend codebase.

## Security analysis: token in `user_data`

**What's in `user_data`:** only the per-box agent bearer token
(`tmag_<64 hex>`, SHA-256-hashed in `agent_tokens`, linked to one `Instance` →
one `userId`), plus `termag_url`, git name/email, and `remote_unix_user`. **No
OAuth secrets, no DB password, no git PAT.** (Private-repo clone, if enabled,
pulls its PAT from `BOX_GIT_TOKEN_SECRET_ARN` via Secrets Manager at boot —
deliberately not in `user_data`.)

**What the token grants:** authenticate a WebSocket as *that box's* agent
(replacing any existing agent for the same `instanceId`). It is a pure
application-layer bearer token — **it cannot call any AWS API.** The box's AWS
blast radius is governed entirely by the instance role + permissions boundary,
a separate credential the bearer token can't touch. It also can't reach other
boxes or other users (token→instance→userId is fixed).

**Attack vector:** the box runs attacker-influenced AI agents. Any process on
the box that does the IMDSv2 dance can read `/latest/user-data` and extract the
token, then connect to the orchestrator off-box as that box's agent, kick the
real agent, and MITM that one user's terminal sessions on that one box.

**Why it's largely moot:** the same token already lives on the box in plaintext
at `~termag/src/termag/agent/agent.config.json` (mode 600, owned `termag`) — the
agent must read it to authenticate, and everything on the box runs as `termag`.
So any code that could exfiltrate it from `user_data` can already read it from
the config file. The per-box-Secrets-Manager alternative does **not** fix this —
cloud-init would just write the same plaintext into the same config file; it
only narrows the thin edge of a *non-`termag`* principal reading via IMDS
(which doesn't really exist on a single-tenant box).

**What actually bounds the risk:**
1. The token has **zero AWS authority** — the boundary on the instance role is
   the real ceiling and a leaked bearer token can't escalate.
2. Scope is **one box / one user** — no lateral movement.
3. **Replacement rotates it** (`user_data_replace_on_change`); terminate sets
   `revokedAt`.
4. The only real way to remove on-box plaintext exposure is **short-lived /
   exchanged-at-boot session credentials** — a larger change, punted past V1.

Action item: add a one-line comment in the cloud-init generator noting what's in
`user_data` and that the boundary is the real control.

## Known issues to fix alongside

- **packer `setup.sh` stale comment (lines ~146–154):** claims cloud-init writes
  `~termag/.config/termag/agent.config.json` and pre-creates that dir, but the
  baked unit's `ExecStart` reads `~/src/termag/agent/agent.config.json`. The
  `.config/termag` mkdir + comment are dead/wrong (harmless today). Fix in the
  same PR.

## Implementation order

1. `boxProvisioner.ts` (provision + terminate) + cloud-init TS port.
2. Wire `instances.ts` create/terminate + schema columns + stuck sweep.
3. `.env` wiring (module outputs → consumer secret payload).
4. Frontend `instancesApi` + Boxes section + Add box modal + project picker.
5. Fix the stale packer comment.
6. Once proven end-to-end, delete `terraform/box/`.
