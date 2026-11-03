# Orchestrator-driven box provisioning ("Add box" button)

**Status:** implemented. The design below shipped as
`backend/src/services/boxProvisioner.ts`, wired into `backend/src/routes/instances.ts`
and the UI's "Add box" button. Steps 1 to 5 of [Implementation order](#implementation-order)
are done. Step 6, deleting `terraform/box/`, is not.

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
| Agent registry | `backend/src/services/agentRegistry.ts` | Dual-keyed (`instanceAgents` by `instanceId`). When a box dials `ws://<host>:3040/termag/ws/agent` with `Authorization: Bearer <token>` (older agents: `?token=…`, see `auth/agentWsToken.ts`), `validateAgentToken` resolves token→`{user, instance}` and `registerAgent` flips the Instance to `ready` and reconstructs its sessions. **Needs no changes.** |
| WS auth | `backend/src/index.ts` (`/ws/agent`) | `validateAgentToken` (in `routes/agentTokens.ts`) looks up `tokenHash`, returns `{user, instance}`. **Needs no changes.** |
| Box shape (reference) | `terraform/box/` | V1 Terraform: egress-only SG, IMDSv2 instance, `cloudinit.sh.tftpl` that writes `agent.config.json {termag_url, token, path_remap}` and starts the agent systemd user unit. |
| Box AMI | `packer/` | Prebakes repo, agent CLIs, `termag` user + linger, the `termag-agent.service` unit. |
| Guardrails | your IAM-grant Terraform (the orchestrator module's box-provisioning grant) | IAM grant + outputs (`box_resource_prefix`, `box_permissions_boundary_arn`, `box_managed_tag`, `agent_ws_url`) built specifically so the orchestrator can launch boxes via the SDK within a locked blast radius. |

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
   so no redeploy is needed when a new AMI is baked. A user's `box-image` flag
   (services/boxImage.ts) may name another of our images — a pinned AMI or a
   channel — falling back to the published image when it is unusable.

### Flavors are strategies (`backend/src/services/boxFlavor.ts`)

A flavor is a spec record, not a boolean fork. `full` (published) and
`minimal` (lean) each own three decisions the launch reads — which image its
resolvers fetch (a flavor's missing image fails loudly, never a substitute),
the disk a box falls back to when neither the request nor a repo file asks,
and warm-pool eligibility (pool boxes always run the full bake) — plus
whether it reads per-user flags at all (the minimal flavor never spends the
`box-image` flag read). The launch, the route's disk decision and
the claim gate read `flavorSpec(a.flavor)` from one record, so a future
image-resolution variant (a channel the flag names, a documented second
component) is a new entry, not another boolean threading through the route.

### The minimal flavor (`--minimal`)

`termag box create <name> --minimal` (and `flavor: 'minimal'` on
`POST /api/instances`) asks for a second flavor. Same SG, role, user_data and
cloud-init — what differs is the image discovery and the warm-pool decision:

- **Image**: the newest self-owned AMI tagged `Component=box-min`
  (`resolveMinimalBoxImage`). There is **no fallback** the way a bad
  `box-image` value does — the owner asked for a minimal box, and silently
  handing them the full bake is the opposite of the ask. A missing `box-min`
  image fails provisioning loudly with the discovery error on the row.
- **Disk**: the same chain a full box takes ("Disk size" above) — an explicit
  `--disk` or a repo's `environment.json` `resources.diskGiB` wins — with one
  flavor-specific default: the fallback when nothing asks is
  `BOX_MINIMAL_ROOT_VOLUME_GB`, **60** (`services/boxDiskSize.minimalDefaultDiskGiB`),
  instead of `BOX_ROOT_VOLUME_GB`'s 120. "A lean image on a 120GB disk is
  100GB of nothing" is exactly what the flavor exists to avoid. The launch
  still never goes under the image's own snapshot (`boxProvisioner.amiWithDisk`),
  and a repo asking for more gets more.
- **The owner's `box-image` flag is ignored for a minimal box.** The flag is
  per-user and chooses among full-bake images; a minimal request is per-box
  and they would fight. `Instance.imageSource` records `'minimal'`, which the
  box list renders through the same badge branch that renders
  `pinned`/`channel`.
- **Warm-pool claims are skipped**: pool boxes run the published full image,
  so a minimal request always goes cold, whatever the owner's flags say.
- **Retry preserves the flavor**: a failed minimal box relaunched through its
  project's Retry comes back minimal (`relaunchBoxFor` carries the row's
  flavor into the new create).

What the `box-min` image must have is the box contract plus what its panes
run: the placeholder `termag` unix user (group, sudo and docker membership,
linger) that the cloud-init rename expects, nvm + a default node alias
(termag-agent.service sources nvm; there is no system node), the agent
checkout npm-installed at `~termag/src/termag/agent`, the termag CLI
installed beside it (`cli/install.sh`, so `ssh box -- termag …` works),
`git` (cloud-init step 6 runs `git config` under `set -euo pipefail`), and
the SSM agent (Canonical ships it). Next to those, four things whose
consumers are contract, not dev bench: `tmux` (agent-created panes), `gh`
(first-run GitHub auth), `jq` (reconcile's config merges), **Docker**
(projects run their compose stacks in panes; the engine + buildx + compose
+ the shared-services ECR credential helper — images pull per project, the
pre-pulled set stays out), and the **agent CLIs** with the full bake's shapes
(@anthropic-ai/claude-code, @openai/codex, pi@1.0.2 pinned --ignore-scripts,
cursor-agent, devin). build-essential + python3 are there for the agent's
node-pty compile. The deploy/ units, the TERMAG_BOX marker and the
guest-browser wiring land through the same `box-lib.sh` helpers the full
bake uses. Everything else the full bake installs — language toolchains,
Playwright, Chromium, browser-harness/clickhousectl, awscli, the
webapp/dev clones and caches — is deliberately absent; the owner's
bootstrap brings it. Skills and MCP registrations are not baked either:
they re-land from the checkout through termag-reconcile at boot, and what is
opinionated among them becomes the bootstrapper's choice once the reconcile
split upstream lands.

The image ships from **`packer/box-min.pkr.hcl`** — the standard template cut
to the contract (no toolchain provisioners, no webapp bake, no incremental
mode — a full bake is minutes). The same NitroTPM post-processor registers
`Component=box-min` onto the finished image, and the root snapshot is a 60GB gp3
volume (`root_volume_gb`). It bakes either target from the same workflow as
the full image:

- **Actions → "Publish AMI" → target `box-min`** — publish on tags
  `Component=box-min` (what `--minimal` discovers); publish off bakes a
  `box-min-candidate` discovery ignores, for validating a branch.
- The schedule carries it: **`check-box-min-ami`** compares the newest
  box-min image's `TermagSha` tag against main over the template's inputs (the
  whole of `deploy/` is a staleness signal here, because the lean image's
  reconcile unit re-lands it from the checkout at boot) and rebakes it past
  `BOX_AMI_MAX_AGE_DAYS`.
- The nightly retention sweep keeps the newest 3 `Component=box-min` images
  like the published full image (candidates get `box-min-candidate`'s own
  keep-N).

The wiring lint `packer/scripts/box-min.test.sh` enforces the shape of the
lean bake: nothing from the toolchain war may appear in its provisioners,
Docker and the agent CLIs may not quietly disappear (the compilers included
— node-pty), the root volume rides the 60 default, and the home-path index
stays the last provisioner — exactly as `home-paths.test.sh` enforces on the
full template. Until the first bake is published, `--minimal` boxes fail
provisioning with `No box AMI found (tag App=termag, Component=box-min)`.

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
                    ├─ AuthorizeSecurityGroupIngress on HOST SG (3040 from box SG)
                    ├─ CreateRole(+boundary) → AttachRolePolicy SSM core → InstanceProfile
                    └─ RunInstances  (AMI, arm64 type, subnet, SG, profile,
                                      IMDSv2, tags, user_data=cloud-init+token)
                          ↓ EC2 boots, cloud-init starts agent
                          ↓ agent dials ws://<host>:3040/termag/ws/agent (Authorization: Bearer …)
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
3. `AuthorizeSecurityGroupIngress` on `HOST_SECURITY_GROUP_ID`: 3040 from the new
   box SG (grant's `Ec2BoxIngressToHost`). The box reaches the backend directly
   over the private VPC network, not through the ALB.
4. Per-box IAM: `CreateRole` `<BOX_RESOURCE_PREFIX>-<box>` **with
   `PermissionsBoundary=BOX_PERMISSIONS_BOUNDARY_ARN`** (denied otherwise);
   `AttachRolePolicy` `AmazonSSMManagedInstanceCore`; if
   `BOX_GIT_TOKEN_SECRET_ARN` set, add an inline read policy for just that ARN;
   if `BOX_ECR_PULL_REPOSITORY_ARNS` set, add the pull-only `termag-box-ecr-pull`
   inline policy (`services/boxEcrPolicy.ts`; existing box roles are backfilled
   at startup by `backfillBoxEcrPullPolicies`);
   `CreateInstanceProfile` + `AddRoleToInstanceProfile`.
5. `RunInstances`: `amiId`, `BOX_INSTANCE_TYPE` (**must be arm64/Graviton** — the
   AMI is arm64-only), a subnet, box SG, instance profile, IMDSv2
   required, `TagSpecifications` (`Name=<prefix>-<box>`, `ManagedBy`, `Owner`,
   `BoxName`), `UserData` = base64 of a TS port of `cloudinit.sh.tftpl` with the
   token inlined and `termag_url=AGENT_WS_URL`. `BOX_SUBNET_ID` and
   `BOX_FALLBACK_SUBNET_IDS` are one pool with no primary: each launch starts
   in the next subnet of the pool, round robin, so boxes spread across AZs.
   On a capacity refusal (`InsufficientInstanceCapacity`,
   `InsufficientFreeAddressesInSubnet`, or a type the AZ does not offer) the
   launch tries the next subnet in the pool, wrapping around, then the next
   type in `BOX_FALLBACK_INSTANCE_TYPES` in every subnet again
   (`launchCandidates`). `VcpuLimitExceeded` does not walk on: the Graviton
   general-purpose types share one quota bucket. Fallback subnets must be
   private with a NAT route, in `BOX_VPC_ID`. A pool box launched on a
   fallback type keeps the configured type's pool spec hash. A caller of
   `provisionNewBox` may pass `instanceTypes` (`{ type, fallbacks }`) in its
   launch choices. That type and its own fallbacks then replace the
   configured ones, so the walk never falls back to `BOX_INSTANCE_TYPE`
   (`withInstanceTypes`). Box sizes (below) pass one for every sized box;
   the preview fleet will pass its own. The type a box
   launched as is recorded in `Instance.instanceType`.
6. Each handle is persisted the moment its resource exists: `region` +
   `securityGroupId` after `CreateSecurityGroup`, `iamRoleName` after
   `CreateRole`, `iamInstanceProfileName` after `CreateInstanceProfile`,
   `ec2InstanceId` after `RunInstances`, then `hostname` (best effort: a failed
   write is logged and never fails a box that is already running). A launch
   cut short (restart, SDK error) therefore leaves a row that teardown can
   clean up from, and teardown only marks itself finished if none of these
   handles changed while it ran.

`terminateBox(instance)`: `TerminateInstances` (tag-scoped) → revoke the ALB
ingress rule → delete SG (after the instance is gone) → detach/delete role +
instance profile + every inline policy `ListRolePolicies` reports. (No secret
to delete, since the token lives in `user_data`.) A resource that is already
gone (`InvalidInstanceID.NotFound`, `InvalidGroup.NotFound`, `NoSuchEntity`)
counts as done, so re-running a teardown costs a few NotFound answers. The
route and pool retirement mark the row `terminated` first and tear down in
the background, so only a run where every step succeeded stamps
`Instance.cleanedUpAt`. The provisioning sweep re-runs teardown, a few per
tick, for terminated ec2 rows without it once `BOX_TEARDOWN_RETRY_SECONDS`
(10 min) have passed since both termination and the last attempt
(`cleanupAttemptedAt`, stamped through a guarded update so one row is never
torn down twice at once).

**Cloud-init port:** copy from `terraform/box/cloudinit.sh.tftpl`, **not** from
packer's comment. The baked `termag-agent.service` runs
`agent.js <home>/src/termag/agent/agent.config.json` (argv), so the config must
land at `~termag/src/termag/agent/agent.config.json` — which is what the
`terraform/box` template does. (packer's `setup.sh` comment claiming
`~/.config/termag/agent.config.json` is stale/wrong; see Known issues.)

### Box sizes (`backend/src/services/boxSize.ts`)

A box launches at a size, each an arm64 type and its same-shape fallbacks:

| Size | Type | vCPU / GiB | Fallbacks, in order |
|---|---|---|---|
| `small` | `m8g.large` | 2 / 8 | `m7g.large`, `r8g.large`, `r7g.large`, `m8g.xlarge` |
| `medium` | `m8g.xlarge` | 4 / 16 | `m7g.xlarge`, `r8g.xlarge`, `r7g.xlarge`, `m8g.2xlarge` |
| `large` | `m8g.2xlarge` | 8 / 32 | `m7g.2xlarge`, `r8g.2xlarge`, `r7g.2xlarge`, `m8g.4xlarge` |

`BOX_SMALL_INSTANCE_TYPES`, `BOX_MEDIUM_INSTANCE_TYPES` and
`BOX_LARGE_INSTANCE_TYPES` (comma-separated; the first is launched, the rest
are its fallbacks) replace a row. A non-arm64 name is dropped with a warning.

- **Which size**, in this order, one function (`decideBoxSize`), which the
  launch and the New box dropdowns both use:
  1. the one asked for: `size` on `POST /api/instances` and the CLI's
     `POST /boxes` (`termag box create --size`, `termag project create …
     --new-box --size`, `termag ask --new-box --size`), or a pick in a New box
     dropdown. A size outside the three is 400 `invalid_size`;
  2. the repository's `.termag/environment.json` `resources` (below), the largest across
     a multi-repo project's repositories. The repositories are the ones the
     box is made for: `repo` on the API, one or a list (the New project and
     new chat forms send the one picked), or the CLI's `--from`, once per
     repository, resolved as `POST /projects` does;
  3. the owner's `box-default-size`.

  A box made for an ask (`createdFor: "ask"`: `termag ask --new-box`, and the
  deprecated `--for-ask`) is sized the same way: asks do the same work people
  do.
- **The New box dropdowns preselect the same answer.** In the simple UI's box
  dialog (LaunchPad's `Select`, as generative UI's Select field draws it,
  laid out like the dialog's Name field) and the full UI's New project form (a
  native select, as its Agent field), each labelled from the size table as
  "Medium · 4 vCPU, 16 GB RAM" (the name emphasised and the specs muted in
  LaunchPad's options; one tone in the native select). No default is marked.
  `GET /api/instances/sizes?repo=<url>` answers `defaultSize`, what a box with
  no size picked launches at for that repository, which they preselect (and
  read again when the repository picked changes,
  `frontend/src/hooks/useBoxSizes.ts`; the desktop app reads the same answer
  from `GET /api/cli/v1/boxes/sizes?repo=<url>`). When the person picks nothing they
  send no size, so the server decides by the same order. A repository whose
  environment.json asks for requirements adds one entry above Small, Medium and Large,
  named by the type EC2 matched (`r8g.xlarge`), and preselects it
  (`defaultRequirements`). There are no free-form CPU or memory fields. The
  warm pool holds every preset (below), so any of them can come from it.
- **The flag** (`box-default-size`, string, read for the owner): `small`,
  `medium` or `large`. Its off variation and fallback `""` mean no size: the
  box launches as `BOX_INSTANCE_TYPE` and `BOX_FALLBACK_INSTANCE_TYPES`, as
  before sizes, the repository's environment.json is not read, a size asked for is
  refused (403 `box_size_disabled`) and the dropdowns are hidden
  (`GET /api/instances/sizes` answers `enabled: false`). So it is also the
  feature's release flag. Its `large` is today's production type.
- **Recorded** on `Instance.size` (null: no size), beside `instanceType`, and
  shown in the Boxes list (a badge, the type in its tooltip), the simple UI's
  box dialog, `termag box list` (`SIZE`) and the admin Fleet tab. A box sized
  by a repository's requirements records them as `4vcpu-32gib` and shows as
  its type alone (`r8g.xlarge`); a preset shows its name.
- **The warm pool** holds each preset apart; see "Warm pool sizes" below. A
  claim asks for the size the box would launch at, and the claim statement
  matches `"size"` itself (`warmPoolClaim.takeWarmBox`), so a claim never
  hands out another size. A box sized by a repository's requirements launches
  cold, unless EC2's first match for them is a preset's type (4 vCPU and 16 GiB
  is `m8g.xlarge`, so medium). Pool entries for common repository requirements
  are a possible follow-up.
- **A failed box's Retry** relaunches at the failed box's size.
- **An existing box is resized** from termag itself: Resizing a box, below.

### Disk size (`backend/src/services/boxDiskSize.ts`)

A new box's root disk is chosen when it is made: a whole number of GiB from
**50 to 300**, **120** by default. No flag gates it, `box-default-size`
included.

- **Which disk**, in this order (`decideBoxDisk`):
  1. the one asked for: `diskGiB` on `POST /api/instances` and the CLI's
     `POST /boxes` (`termag box create --disk <GB>`, `termag project create …
     --new-box --disk`, `termag ask --new-box --disk`), or what was typed in a
     New box disk field. Anything but a whole number from 50 to 300 is 400
     `invalid_disk`, before anything is written; so is a disk for a box this
     orchestrator doesn't launch (external);
  2. the repositories' `.termag/environment.json` `resources.diskGiB` (below),
     the largest across a multi-repo project's;
  3. `BOX_ROOT_VOLUME_GB`, 120 unset: the floor every launch used before.
- **The launch** sizes the root volume to it (`boxProvisioner.amiWithDisk`),
  but never under the image's own snapshot, which EC2 refuses: the box AMI is
  120 GB today (`packer/box.pkr.hcl`), so anything from 50 to 119 launches at
  120. Hibernation's swap file still goes on top (`planHibernation`): 200 GB on
  a 32 GiB type is a 232 GB volume.
- **Recorded** on `Instance.diskGiB`: at create, then at launch with what the
  box got (the image's floor applied, hibernation's RAM not counted). Shown in
  the Boxes list (in the size badge's tooltip: the list is too narrow for a
  second badge), each box's line in the simple UI's box dialog ("Running ·
  medium · 200 GB disk"), `termag box list` (`DISK`), what
  `box create`, `project create --new-box` and `ask --new-box` print ("large,
  200 GB disk"), and the admin Fleet tab (`disk`). Null for boxes from before
  it was recorded, and external ones.
- **The New box disk fields**: a number field in the simple UI's box dialog
  (LaunchPad's `NumberField`, under Size) and the full UI's New project form (a
  native number input, under Box size), shown whenever `GET
  /api/instances/sizes` answers `disk` (`minGiB`, `maxGiB`, `defaultGiB`, and
  `diskGiB`, what a box for `?repo=` gets). They preselect `diskGiB` and send
  nothing until the person types, so the server decides by the same order; a
  value typed for one repository is dropped when the repository changes
  (`useBoxDiskPick`).
- **The warm pool** launches every box at the default, so a box asked for at
  any other disk launches cold, without asking the pool (`box.pool.claim` miss
  reason `disk-not-pooled`). Cold is about 70–95 s against a hit's ~45 ms, so
  only while a warm box is ready do the fields say so ("A 200 GB disk means
  launching a new box, a few minutes; the ready ones have 120 GB."), and the
  full UI's "ready now" turns into "a few minutes".
- **A failed box's Retry** relaunches with the failed box's disk.
- **After creation** a disk only grows, through the admin Fleet tab's Grow
  disk (#791, `services/boxDisk.ts`), which works on the whole volume and
  doesn't update `Instance.diskGiB`. EBS volumes never shrink, and there is
  no owner-facing resize.

### Warm pool sizes (`backend/src/services/warmPoolSizes.ts`)

With `box-default-size` serving a size for the pool's fixed context
(`POOL_LD_CONTEXT`), the pool can hold some of each size, so a claim of any
size can be a hit. The counts are the JSON flag `box-warm-pool-sizes`, read
for the same fixed context:

```json
{"small": 4, "medium": 2, "large": 2}
```

- **When the flag serves an object, its counts are the pool.** The total is
  their sum. `box-warm-pool-size` is not read and is not a cap: 4/2/2 holds 8
  boxes with `box-warm-pool-size` at 5. A size the object leaves out takes its
  code default (`DEFAULT_WARM_POOL_SIZES`, small 4, medium 2, large 2), so
  `{}` is 4/2/2 and `{"large":3}` is 4/2/3. A key that is not a size is
  ignored with a warning. Every count at 0 drains the pool.
- **One safety ceiling, on the total, in code:** at most
  `WARM_POOL_TOTAL_CEILING` (20) boxes in all. No size has a limit of its own.
  A sum above 20 is clamped by filling smallest size first, so the excess
  comes off the largest: 15/15/15 holds small 15, medium 5, large 0. The clamp
  is logged once per value (`[POOL] box-warm-pool-sizes served … clamped to
  small=15 medium=5 large=0 (at most 20 in all, smallest first)`).
- **When the flag serves nothing or a malformed value, the pool is the
  single-size pool it was before per-size counts.** That covers the flag
  unset, the flag source unable to answer, a value that is not an object, and any
  count that is not a whole number of 0 or more. The pool is then
  `box-warm-pool-size` boxes of the pool's `box-default-size`. Sizes other
  than that one drain, and claims of them go cold. A malformed value logs one
  warning per value.
- **`box-warm-pool-size` only applies to the single-size pool**: that
  fallback, or sizes off. There it is still clamped to 0..20, and `0` still
  drains. `WARM_POOL_TARGET_SIZE` stays the e2e stack's override of it, so it
  too only sizes the single-size pool.
- **Sizes off for the pool** (`box-default-size` serving `""`): one pool of
  `box-warm-pool-size` boxes of `BOX_INSTANCE_TYPE`, on the hash it had before
  sizes, and `box-warm-pool-sizes` is not read.
- **The reconciler plans each size apart** (`warmPool.poolGroups`): one
  planner run per size over that size's rows, against that size's spec hash
  (the size is in the hash, so each size rolls over on its own). Failed rows
  go to every run, so the breaker still reads the whole pool's warm path. The
  in-flight cap (`WARM_POOL_MAX_INFLIGHT`) stays shared: each size gets what
  the other sizes' booting boxes, and the launches planned before it in the
  tick, leave of it. Sizes are filled small, then medium, then large. The
  insert's serializable re-count checks the size's supply against its target
  and the whole pool's `warming` rows against the cap.
- **A size the pool no longer wants**, because its count went to 0, sizes
  were turned off or on, or a box has no size while sizes are on, is planned
  at target 0, so it drains (`drain` in the retire line).
- **Claims.** `POST /api/instances` and the claude runner's auto-box ask
  `warmPoolTargetFor(size)` first. 0 means the pool holds none of that size,
  so the claim goes cold without asking (`size-not-pooled`). Otherwise
  `poolSpecHashOrNull(size)` answers the size's hash when a box of it is warm,
  and `null` (cold, `no-warm-box`) when none is. A claim whose candidates all
  fail goes cold as before (`every-candidate-failed`). Every fallback is the
  cold launch at the size the claim asked for.
- **Tuning.** Each claim the pool could serve but for size or supply (the
  owner is in `warm-pool-enabled`, on the published image, with the pool's
  hibernation value) is logged as `[POOL] claim hit|miss size=<size>
  via=add-box|claude-runner user=<unix user> [reason=<reason>]` and recorded
  as the `box.pool.claim` product event (`size`, `outcome`, `reason`, `via`).
  Count misses by size to move the counts. The tick line has the size
  (`[POOL] tick size=small spec=… target=4 …`), and so does each warm-up line
  (`[POOL] warm <id> size=small after 41s`). `GET /api/warm-pool` reports
  `target`, what the reconciler holds in all (the per-size sum when
  `box-warm-pool-sizes` serves an object, else `box-warm-pool-size`), and
  `targets` by size, from the same `warmPoolTargets()` the reconciler reads.
  It also reports `specHashes`, one per size it holds; `specHash` is the first
  of them, kept for older readers.

**Why per-size pools rather than resizing on claim.** The other design keeps
warm boxes stopped and, on a claim, changes the instance type
(`ModifyInstanceAttribute`, allowed only while stopped) and starts the box, so
one pool serves every size. Three findings rule it out for now:

- Warm boxes are held **running**, not stopped. A claim needs the box's agent
  connected to this process (`liveInstanceIds`), and is a `box-claim` RPC to
  it. The planner's liveness rules (`agent
  lost`) and the "ready now" line rely on that too. Holding them stopped means
  a new pool state, a claim that starts a box and waits for its agent, and a
  capacity fallback at start time (`InsufficientInstanceCapacity` on the new
  type would mean another modify and start while the person waits).
- **A hibernated instance can't be modified** at all. AWS: "While your instance
  is hibernated, you can't modify it. This is different to a stopped instance
  that isn't hibernated, where you can modify certain attributes, such as the
  instance type or size"
  ([hibernation limitations](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-hibernate-overview.html#instance-hibernate-limitations)).
  So a pool held stopped would have to stop plainly. Pool boxes launch
  hibernation-capable, with the root grown by their RAM for the swap file, so
  a box resized from small to large would have too little root to hibernate
  later. Hibernation would fall back to a stop.
- **Timings**, from production `box.*` product events and `[POOL]` logs,
  2026-10-27/28:

  | Path | Time | Source |
  |---|---|---|
  | Warm claim, a hit | 31–96 ms, typically ~45 ms (24 claims) | `box.provisioned` `claimMs` |
  | Start a stopped box until its agent connects | median 15 s, p90 18 s, max 31 s (32 starts) | `box.resumed` `durationSec`, `from: stop` |
  | Resume a hibernated box | 91 s, 109 s (2) | `box.resumed`, `from: hibernate` |
  | Stop a running box | median 48 s, p90 57 s (48 stops) | `box.sleep.settled` `settleSec` |
  | Cold launch until the box is ready | 69–94 s (8) | `box.ready` `provisionSec` |
  | Pool launch until warm | 34–133 s, about half near 40 s | `[POOL] warm … after Ns` |

  A resize claim would cost one `ModifyInstanceAttribute` call (not measured:
  the box role used for this lacks the permission) plus a ~15 s start, so it
  would take ~16–20 s against ~80 s cold. That is clearly faster than cold,
  but it is hundreds of times a hit's ~45 ms, on every claim, for every size. Per-size
  pools keep a hit at ~45 ms and only need counts tuned, which the
  `box.pool.claim` misses say how to do.

  Resizing could still help on a miss, as a later change: take a warm box of
  another size, stop it (~48 s), modify it and start it (~15 s). At ~65 s that
  beats a cold launch only slightly.

### Claimed boxes run current main (`backend/src/services/claimUpdate.ts`)

A pool box runs the commit its image was baked from until something moves it,
and the stale-box push (`services/boxUpdate.ts`) only moves a box that is
behind the newest *box image*. Between a merge and the next bake (up to a few
hours) a claimed box therefore ran without the merge: on 2026-10-30 four new
boxes launched without #1099's Fireworks /model menu. So a claim brings the box
to current main before anything is launched on it:

1. **Decide, inside the claim.** `welcomeOwner` (`warmPoolClaim.ts`) asks
   `claimUpdateDecision`: update when the box is managed, the orchestrator
   knows its own commit, the agent runs another one (or cannot say which), and
   the agent announces `box-update-v1`. If so, the row gets
   `claimUpdateStatus = 'updating'` before the claim answers, so the claim's
   own answer and the next box-feed poll both say so.
2. **Update, after the credentials.** Once the claim's credential delivery has
   landed (the pull may need the owner's GitHub credential), the agent's
   `box-update` RPC starts `termag-box-update.service`: pull `main`,
   `termag-reconcile`, hooks, deps, restart the agent. Its policy ask
   (`GET /api/box-update/policy`) says yes for a row reading `updating`
   (`reason: 'claim'`), whatever `box-auto-update-enabled` says, for at most
   `CLAIM_UPDATE_POLICY_MS`.
3. **Wait for the report and the hello.** The run's report clears
   `updatePushedAt`; when it says `agent=restarted`, the claim waits for the
   new agent's hello and its credential delivery. When it says
   `reconcile=reconciled` with no restart (only `deploy/` changed), the claim
   closes the socket so the agent says hello again: the capabilities a launch
   reads (the `fireworks-menu-v1` marker, say) are read at hello.
4. **Launch.** The hold is released; the row says `updated`, `current`,
   `skipped`, `failed` or `timed-out`, with the reason in
   `claimUpdateDetail` and one `[CLAIM-UPDATE] <box> (<owner>): <status> after
   <N>s: <detail>` line (a warning for `failed` and `timed-out`, ending
   "launching on the commit it has").

**The target** is the orchestrator's own commit (`termagVersion()`, what
`GET /api/version` reports), not `origin/main` and not the box image's
`TermagSha`. The orchestrator has no GitHub credential to read `main` with;
the box pulls `origin/main` itself whatever target it is handed; and the
orchestrator's commit is the code that decides which box capabilities to use,
so a box at it or later is current enough. A box ahead of the orchestrator (a
bake after the last orchestrator deploy) runs the update anyway, finds nothing
to pull and reports `current` in a few seconds.

**Never blocking the person.** The whole wait is bounded by
`CLAIM_UPDATE_TIMEOUT_MS` (150 s) from the claim. A timeout, a failed RPC (an
agent without the unit) or a failed run releases the hold, and the launch goes
ahead on the commit the box has, with the reason logged and on the row. A
credential delivery that leaves less than `CLAIM_UPDATE_MIN_RUN_MS` (60 s) of
the bound sends no update at all, so no restart lands under a launch the hold
has already let through. An orchestrator that stops mid-update takes its hold
with it; its row stays `updating`, which the UIs read as over once
`CLAIM_UPDATE_POLICY_MS` (210 s) has passed since `claimUpdateStartedAt`, and
the warm-pool tick marks `timed-out` (`expireStaleClaimUpdates`).

**What waits.** The hold is in the claiming process's memory
(`claimUpdateGate.ts`); that process holds the box's socket, which every launch
is sent through. Pane launches (`ensureAgentSessionsAndLaunch`), a project's
clone or checkout (`applySetupEvent`, deferred to the background so project
create answers at once and the project opens), a workspace's clones, a chat
turn (`chatSendFor`), a resumed chat's restore and an ask (the claim's
connection is settled only after the update) all wait. The cloud runner's
placement does not wait (its hook gives it 15 s): it answers `box-wait` and the
re-offer places on the box once the update is done.

**What the person sees.** Both chat views' setup steps show the box step as
active, *Claimed a ready box, &lt;name&gt; · Updating the box…*, and hold the
clone and Claude steps (`frontend/src/chat/newChat.ts`). The classic UI's
project tile and terminal hold say *updating the box…* (`utils/cloneTile.ts`),
as does New project's box line. The box feed keeps polling while a box reads
`updating` (`boxIsSettling`).

**How long a claim takes now.** A current box: as before (one more row write
in the claim, ~45 ms in all). A stale box: the claim still answers at once,
and the first launch waits for the update: the policy ask, a fetch of the
commits since the bake, reconcile, and an agent restart with its reconnect
and credential delivery. That is estimated at 15–30 s, about a minute more when
`agent/package-lock.json` changed since the bake (`npm ci`), and never more
than 150 s. The `[CLAIM-UPDATE] … after <N>s` lines give the real number.

**Not fighting the periodic push.** A claim update that ends `updated` or
`current` counts as the periodic push for the box image's current target
(`boxUpdate.noteClaimUpdated`), so the hello its restart brings does not ask
the box to update again a minute later; a target that moves after it is
pushed as usual. Two runs never overlap (systemd merges the starts, and the
script holds a lock). A fresh claim has no live Claude session, so nothing
defers the restart.

### Resizing a box (`backend/src/services/boxResize.ts`)

A box's owner resizes it from the full UI's box ⋮ (**Resize box**), the simple
UI's session ⋯ (**Resize box**, on the session's own box, its current size beneath as "Medium: 4 vCPU 16GB RAM", or a custom box's AWS type) or `termag box
resize <box> <size>`; an admin resizes anyone's from the Fleet tab's box card
(**resize**), with a reason. Sizes only (small, medium, large, as the table
above), never a raw type, and whatever `box-default-size` says: the flag
gates the New box pickers, not this. There is no flag of its own.

- **Routes.** `GET`/`POST /api/instances/:id/resize { size, force }` (owner;
  another user's box is 404), `GET`/`POST /api/admin/fleet/instances/:id/resize
  { size, reason, force }` (admin session only, like Grow disk; the admin audit
  log row keeps the actor, the size and the reason, and the box's owner sees
  the reason beside the resize), and the CLI's `POST
  /api/cli/v1/boxes/:id/resize { size, force }` (a box's own credentials may
  resize only a box they created, as for terminate). `GET` answers the sizes,
  the current one, the current or last resize, and what would block one now;
  `POST` answers 202 with the resize as it starts.
- **Refusals.** 400 `invalid_size`; 409 `same_size`, `resize_running` (one
  resize per box at a time: the box's open `resize` row in `box_events`, not
  finished and under an hour old; a new row is created with the box's
  `instances` row locked `FOR UPDATE`, so two requests line up and the second
  finds the first's row), `box_changing` (only from `ready`, `stopped` or `hibernated`),
  `pool_box` (an unclaimed warm-pool box: the pool holds its sizes) and
  `box_busy`. A busy box's 409 lists its `blockers`: an agent working, an ask
  turn, a cloud session, an SSH session, a port forward, sustained load (the
  lifecycle sweep's busy checks, `boxLifecycle.busyBoxes`), each `forceable`,
  for the CLI (`--force`) and the API. The UIs always send `force`: their one
  warning (the downtime notice) is the confirmation, so they show no second
  notice. A warm-pool claim still setting the box up, or a box update in
  flight, is not forceable, and its reason shows as the dialog's error. 503
  `resize_not_permitted` when a `DryRun` `ModifyInstanceAttribute` says the
  orchestrator's role may not set the size's type, before the box is touched.
- **Steps** (`runResize`), each written to the resize's `box_events` row (`phase`) and pushed
  as a `box-resize` frame on the status socket to the owner and the actor,
  plus the usual `workspace` boxes change: first the size's types within the
  resize cap (Graviton m and r, `m8g`/`m7g`/`r8g`/`r7g`, up to 8 vCPU and
  32 GiB, `resizeTypeAllowed`; so `large` skips its 64 GiB r 2xlarge and
  16 vCPU 4xlarge fallbacks) that the box's zone offers
  (`DescribeInstanceTypeOfferings`; none, and it fails before stopping
  anything); `resuming` (a hibernated box only: EC2 can't modify a
  hibernated instance, so it is resumed and then stopped plainly; its RAM is
  not kept); `stopping` (`requestPower` stop, until the power sweep settles
  the row `stopped`); `resizing` (`ModifyInstanceAttribute` to the size's
  first offered type); `starting` (`requestPower` start; a capacity refusal
  retypes to the size's next type, `boxSize` fallbacks in order, and starts
  again; when every type is refused, the box goes back to its old type and
  is started); `ready` once its agent reconnects. A box that was stopped or
  hibernated is retyped and left `stopped`; its next start runs at the new
  size (and, with no capacity then, is refused like any start). A failure
  after the stop starts a box that was running again, on whatever type it
  has; a hibernated box whose resume began and whose stop never took is
  stopped again, since it was down when asked. Every other power request (the owner's Start, the sweep, an ask's
  wake) is refused while the lock holds (`requestPower` without `forResize`),
  in its guarded write (`resizeFreeWhere`: a NOT EXISTS on the open row), so a
  request that read the box before the lock was taken can't move it either;
  an ask's wake waits instead of failing. Queued asks aren't sent to a box a
  resize holds either, even while it is up (a hibernated box is resumed to
  `ready` before its plain stop), so no turn starts only to be stopped. The owner's resize of a running box restarts
  its idle clock, as a Start would.
- **Recorded**: `size` and `instanceType` on the box once the type changed (a
  start or reconnect that fails afterwards still records them), and the
  operation itself as one row in `box_events` (`services/boxEvents.ts`; see
  Box events below): `kind: resize`, who asked (`actorId`, `actorRole`
  owner or admin, an admin's `reason`), `from`/`to` sizes, `phase` (requested,
  then the steps, then `done` or `failed`), `startedAt`/`finishedAt`, the
  `error`, and `detail` (`fromStatus`, which the steps follow; `fromType`,
  `toType`, `end`: ready or stopped, `fallback`, `reverted`, `forced`, `via`,
  `durationSec`). Every resize keeps its row. A box resized to a type with
  more RAM than it launched with loses `hibernationConfigured` (its root only
  holds the old RAM for hibinit-agent's swap file, so every hibernate would
  fall back to a stop), and the UIs offer Stop only from then on. A box
  claimed from the warm pool loses its `poolSpecHash`. The product event is
  `box.resize` (from, to, the types, actor, via, startState, forced, outcome,
  fallback, reverted, durationSec), and `box.resumed` / `box.sleep.*` say
  `by: resize` for its own starts and stops.
- **A process that dies mid-resize** (a deploy) leaves its row open; after an
  hour (`RESIZE_STALE_MS`) it no longer holds the box, the views say the
  resize was cut off, and the box is wherever the job left it (often stopped).

### Starting a stopped box with no capacity (`backend/src/services/boxStartFallback.ts`)

A launch walks subnets and then types when EC2 has no capacity (step 5
above). Starting a box that already exists can't change subnet: its root
volume and network interface stay in its zone. Behind
`box-start-type-fallback-enabled` (boolean, off; read for the owner and box,
or the pool context for a pool box), a start of a **stopped** box that EC2
refuses for capacity retypes it and starts it again:

- **Candidates**: the box's size's types (`boxSizeSpec`), or
  `BOX_INSTANCE_TYPE` and `BOX_FALLBACK_INSTANCE_TYPES` for a box with no
  size, kept only when DescribeInstanceTypes gives the same vCPU and memory as
  the type it has (so it costs the same and keeps hibernation), the
  provisioner role may set it (`resizeTypeAllowed`, terraform's
  `box_resize_instance_types`), and it can hibernate if the box does. A large
  `m8g.2xlarge` box falls back to `m7g.2xlarge` and back again.
- **The walk**: ModifyInstanceAttribute, then StartInstances, for each in
  order; a capacity refusal moves on, any other error ends it. A box none of
  them starts goes back to the type it had, and the start fails with the
  first refusal, as before. `Instance.instanceType` follows each retype.
- **Not covered**: a hibernated box (EC2 can't modify one, and no API drops
  its saved RAM without starting it) and a resize's own starts (`forResize`),
  which walk their own types.

### Box events (`backend/src/services/boxEvents.ts`)

Fleet operations on a box are rows in `box_events`, one per operation,
created when it is asked for and updated as it goes, never deleted: today
`resize` and `disk-grow` (the admin Grow disk, `services/boxDisk.ts`), with
room for stop, start, park and terminate. The admin audit log
(`admin_audit_log`) keeps the request to an admin route; a box event keeps the
operation and how it ended, whoever asked. The latest open row of a kind is
that operation in progress (the resize lock and its 409, the UIs' progress);
an open row older than an hour counts as cut off. Rows outlive their box
(`boxId` set null, `boxName` kept). The Fleet tab's box card lists a box's last
10 (`operations`). A disk grow's row: `from`/`to` in GB, phase `modifying`,
`filesystem`, then `done` or `failed` with the error (an EC2 refusal of the
modification too), `detail` the volume and the result line; a failed write is
logged and never fails the grow, which keeps its `[BOX-DISK]` log lines.
- **AWS.** The provisioner role's `Ec2ResizeTaggedInstances` statement
  (terraform `projects/termag/root-modules/orchestrator/modules/box-provisioning/iam.tf`)
  allows `ec2:ModifyInstanceAttribute` only on `ManagedBy`-tagged instances and
  only for `ec2:Attribute/InstanceType` in its list: the Graviton m and r
  types up to 8 vCPU and 32 GiB, the same cap as `resizeTypeAllowed`; change
  both together. A box running a type outside it (an older `m9g`, `m6g` or
  `t4g` box) can be resized to a size, but a resize that finds no capacity
  can't put it back on that type, and leaves it stopped with the error.
  Before that change the role allowed `ModifyInstanceAttribute` for every
  attribute.
- **The workflow** (`.github/workflows/resize-box.yml`) is break-glass now:
  the Fleet tab is the normal way. It still resizes any box, or all of them,
  to any type on its own role's list, outside termag, so the row's `size` and
  `instanceType` are not updated by it.

### A repository's environment (`.termag/environment.json`)

A repository can say what its boxes need, in a file committed to the
repository itself. Today that is their size and their disk:

```json
{ "resources": { "vcpu": 4, "memoryGiB": 32, "diskGiB": 200 } }
```

This `.termag/` is the **repository's**, read from GitHub. It has nothing to do
with a termag space's `.termag/` folder (a space's shared memory, `prompt.md`
and `memory/`), even though the folder name is the same.

- **`resources` only, for now.** It sizes every box made for a project of the
  repository, a box made for an ask included. It is a preset (`"small"`,
  `"medium"`, `"large"`, the table above) or requirements, `{ "vcpu": <n>,
  "memoryGiB": <n> }`. The object form may also hold `"diskGiB": <n>`, the
  root disk in GiB (50 to 300, "Disk size" above); `{ "diskGiB": 250 }` alone
  leaves the size to the default, and a preset with a disk is written as its
  shape (large is `{ "vcpu": 8, "memoryGiB": 32, "diskGiB": 250 }`, which EC2
  matches to large's type). A bad `diskGiB` is left out with a warning and
  the size beside it still applies, and the other way round. A multi-repo
  project takes the largest `diskGiB`. Every other key is reserved and ignored without a
  word: the file is to hold `install`, `start` and `ports` too, after
  Cursor's `.cursor/environment.json`, which is then the planned fallback for
  those three. Cursor's file has no resources, so nothing is read from it
  today.
- **A multi-repo project** takes the largest of its repositories' sizes
  (`boxSize.largestBoxSize`): the most vCPUs any of them asks for and the
  most memory, each on its own, so 4/32 and 8/16 make 8/32 (large's shape,
  so large). A preset counts as its shape. A repository with no file, or a
  malformed one (with its warning), adds nothing. The result is resolved to
  a type as any requirements are, and an explicit size still wins.
- **Requirements are minimums**, and EC2 does the matching
  (`services/boxRequirements.ts`): `GetInstanceTypesFromInstanceRequirements`
  for arm64 types of `m8g`, `r8g`, `m7g` and `r7g` with at least that many
  vCPUs and GiB, then `DescribeInstanceTypes` for their shapes. termag orders
  them fewest vCPUs first, then least memory, then the newer generation (in
  these families the price grows with vCPUs, then memory), launches the first
  and walks the rest on a capacity refusal, as a preset's fallbacks. 4 vCPU
  and 32 GiB is `r8g.xlarge`, then `r7g.xlarge`, `m8g.2xlarge`, `m7g.2xlarge`.
  A match is cached for six hours, by requirements. The limit is 8 vCPU and
  32 GiB (`BOX_REQUIREMENT_LIMITS`, large's shape), whole numbers, at least 1.
  The box-resize role must allow the same families.
- **Read** from the repository's default branch at the commit a new project
  would clone (`GET /repos/{repo}/commits/HEAD`, then the file at that
  commit), with the owner's GitHub credential, or with none for a public
  repository when they have none (`services/repoEnvironment.ts`). What a commit
  holds never changes, so it is cached by commit (500 commits); the head is
  asked each time, so a pushed change applies to the next box.
- **Never an error.** No file is no setting. A file that isn't JSON or isn't
  an object, a value that isn't a preset or valid requirements, requirements
  over the limit or that EC2 has no type for, and a GitHub that doesn't
  answer (5 s) each leave `resources` out: the box takes
  the next size in the order, and the create's 201 carries `warnings`, which
  the CLI prints as `termag: warning: …`.
- **webapp** needs more memory than vCPUs: its repository's file is
  `{ "resources": { "vcpu": 4, "memoryGiB": 32 } }`.
  There is no map of repositories in termag's code any more.
- **IAM.** The provisioner role needs `ec2:GetInstanceTypesFromInstanceRequirements`
  (Resource `*`, beside `ec2:DescribeInstanceTypes` in its `Ec2Describe`
  statement, wherever your terraform grants the provisioner role). Without it a
  requirements box falls back to the default size with a warning.
  `ec2:RunInstances` has no instance-type condition, so the r family launches
  as it is.


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
`BOX_INSTANCE_TYPE`, `HOST_SECURITY_GROUP_ID`, optional
`BOX_FALLBACK_SUBNET_IDS` and `BOX_FALLBACK_INSTANCE_TYPES` (comma-separated),
optional `BOX_SMALL_INSTANCE_TYPES`, `BOX_MEDIUM_INSTANCE_TYPES` and
`BOX_LARGE_INSTANCE_TYPES` (Box sizes, above),
optional `BOX_GIT_TOKEN_SECRET_ARN`, optional `BOX_ECR_PULL_REPOSITORY_ARNS`. Most are already module outputs.

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
  **with linger**, the agent CLIs (claude/codex/pi/cursor/devin), the termag checkout
  being baked cloned (full history) to `~termag/src/termag` + the agent's
  `npm install`, and the
  `termag-agent.service` user unit. The SDK only injects per-box runtime config
  on top.
  - The **tag contract is now an API** — don't change `App=termag,
    Component=box` casually. Note `amazon-ebs` now tags its raw output
    `Component=box-base`; a post-processor re-registers it with NitroTPM and
    moves `Component=box` onto the NitroTPM image (see below). Discovery
    (`Component=box`) is unchanged — it just resolves to the NitroTPM AMI.
  - **The AMI's snapshot size is the floor for a box's root volume.** Neither
    provisioning path hardcodes it: `boxProvisioner.ts`'s `resolveRootDevice`
    and `terraform/box`'s `local.root_volume_gb` both read the root device and
    its size off the discovered image and launch with
    `max(configured, AMI snapshot)`. So growing the AMI needs no matching
    change to `BOX_ROOT_VOLUME_GB`, `terraform/box/variables.tf`, or a
    redeploy of the orchestrator — which is what broke provisioning on
    2026-09-16, when the image went 50 → 120GB while the running orchestrator
    still asked for 50 and EC2 refused the launch. The device *name* comes
    from the image too: a mapping for a device the AMI does not boot from
    attaches an extra volume rather than resizing the root.
  - **NitroTPM (TPM 2.0) is baked into the AMI** (`TpmSupport=v2.0` +
    `BootMode=uefi`). Instances inherit it automatically — `RunInstances`/the
    SDK provisioner needs **no** TPM flag. Just keep `BOX_INSTANCE_TYPE` on a
    NitroTPM-supported type (all current Graviton families qualify). See
    `packer/README.md` → "NitroTPM" and `scripts/enable-nitrotpm.sh`.
  - AMI is **arm64-only** → `BOX_INSTANCE_TYPE` must be Graviton.
  - The termag source on a box is **this checkout, not a remote clone**:
    `packer/scripts/bundle-source.sh` bundles the commit being baked (full
    history, no credentials) and `setup.sh` clones it, refusing to bake if
    HEAD is not the commit the AMI's `TermagSha` tag will name (also written
    to `~/.termag-baked-sha`). The clone's `origin` is the checkout's own
    remote URL, so nothing here hardcodes an org.
  - Rebuilds are automatic on `main`: `publish-ami.yml`'s hourly
    `check-box-ami` job diffs the published AMI's `TermagSha` against `main`
    over the inputs that land in the image (`box.pkr.hcl`, the files and
    scripts it ships, `agent/`, the workflow) and bakes on a difference, or
    when the image is older than 14 days. After a bake, `build-box` fails
    unless the published AMI carries `Component=box` and that run's
    `TermagSha`.
  - **First boot fixes the baked `/home/termag` path from an index, not a
    walk.** cloud-init's rename leaves symlink targets and a few text files
    pointing at `/home/termag`. Finding them at boot (`find -lname` over the
    home, `grep -rIl` over the toolchain dirs) walked every inode on a volume
    that EBS restores lazily from the snapshot: 4.5 minutes on the
    pre-quick-start image, 15.5 minutes once webapp and its caches were
    baked — longer than the 15-minute stuck-provisioning sweep — to rewrite
    ~200 symlinks and 3 files. `packer/scripts/index-home-paths.sh`, the last
    provisioner in `box.pkr.hcl`, takes that walk on the warm bake volume and
    writes `/var/lib/termag-bake/home-paths/`; cloud-init (both templates)
    calls `/usr/local/sbin/termag-rewrite-home-paths /home/termag
    /home/<owner>` (`packer/scripts/rewrite-home-paths.sh`), which touches only
    the indexed entries and logs counts and elapsed time. Guarded like the
    rest of steps 3–4: a missing script or index logs a WARNING and the boot
    continues. `packer/scripts/home-paths.test.sh` exercises both halves.
    The other walk was the rename itself: `usermod -m` renames the home and
    then stats every file under it (100,377 `newfstatat` calls for 100,003
    files, measured) to fix ownership that does not change; on the quick-start
    image that was another 4 minutes. Step 2 now does the `mv` itself and
    passes `usermod` no `-m`, so cold boot is the OS boot plus seconds.

- **`terraform/box/` is the spec, then vestigial.** Everything it declares is
  what `boxProvisioner` re-creates via the SDK; its `cloudinit.sh.tftpl` is the
  reference we port to TS. Its IAM choice (shared
  `AmazonSSMRoleForInstancesQuickSetup`) is **superseded** by the
  per-box-role+boundary decision. Recommendation: keep it through
  implementation as the cloud-init reference + a break-glass manual path, then
  **delete it** once the button flow is proven — mirroring how
  the internal Terraform deleted its standalone box module
  ("box lifecycle is owned by the termag backend codebase now").

## Security analysis: token in `user_data`

**What's in `user_data`:** only the per-box agent bearer token
(`tmag_<64 hex>`, SHA-256-hashed in `agent_tokens`, linked to one `Instance` →
one `userId`), plus `termag_url`, git name/email, and `remote_unix_user`. **No
OAuth secrets, no DB password, no git PAT.**

> **`BOX_GIT_TOKEN_SECRET_ARN` is a grant with no consumer.** This section used
> to say a private-repo clone "pulls its PAT from `BOX_GIT_TOKEN_SECRET_ARN` via
> Secrets Manager at boot". `boxProvisioner.ts` does attach the inline read
> policy for it, but **nothing reads the secret** — neither
> `cloudinit.sh.tftpl`, nor the TS port of it, nor `packer/scripts/setup.sh`. Nor
> is it configured in the current deployment: a `secretsmanager:GetSecretValue`
> call from a live box returns `AccessDeniedException`, which is what an unset
> `BOX_GIT_TOKEN_SECRET_ARN` (hence no inline policy) looks like. Treat the
> capability as designed-but-unbuilt; see
> [Deferred options](#deferred-options-for-unattended-setup).

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

## What the box role can actually do

Probed from a live box (role
`example-termag-box-*`) rather than read off the policy, because the
role cannot introspect itself — `iam:ListRolePolicies` on its own role is denied.

| Call | Result | Consequence |
|---|---|---|
| `ssm:GetParameter` on an arbitrary name | `ParameterNotFound`, not `AccessDenied` | the SSM read is **broad, not parameter-scoped** |
| `ecr:GetAuthorizationToken` | `AccessDenied` | image pulls cannot move to boot time |
| `secretsmanager:GetSecretValue` | `AccessDenied` | `BOX_GIT_TOKEN_SECRET_ARN` is unset here |

The SSM grant is not something termag adds. The only policies
`createBoxRole` attaches are `AmazonSSMManagedInstanceCore` and — when
configured — the git-token inline policy, which is demonstrably absent, so the
parameter read arrives with the managed policy or the permissions boundary.

## Deferred options for unattended setup

Three things would each remove a human step. All are deliberately **not** being
done yet; they are recorded here so the reasoning is not re-derived.

1. **Fetch the dev-server token at boot.** Possible today with no IAM change (see
   above). Not done because it puts a credential on disk at boot on a box whose
   whole point is running attacker-influenced AI agents — the same reasoning the
   `user_data` analysis above applies to the agent token. Fetching it on demand,
   as `make` already does, keeps the exposure window narrow for no real cost.

2. **Configure and consume `BOX_GIT_TOKEN_SECRET_ARN`.** This is the one lever
   that would let the repo clones move into cloud-init, because it is the only
   proposed path to git credentials that does not need the owner present. It
   needs a PAT provisioned into Secrets Manager, the env var set, and a consumer
   in both cloud-init paths. Worth weighing against handing every box a
   long-lived org-scoped PAT.

3. **Seed `~/.ssh/authorized_keys` from the owner's GitHub keys.**
   `https://github.com/<handle>.keys` serves a user's public keys over plain
   HTTPS with no authentication — verified returning 200 and two keys for a real
   handle. If cloud-init received a GitHub username it could seed
   `authorized_keys` at first boot, and SSH-over-SSM (so `scp`, `rsync`, `ssh -L`
   port forwarding) would work on a fresh box with no interaction and no secret
   anywhere.

   This is a cheaper variant of the `User.sshPublicKey` column that step 4c was
   reverted for (`2393f6f`): a handle is far easier to supply than a key, and
   `cloudinit.sh.tftpl` already takes owner identity, so it is one more template
   variable. The trade-off is that it installs **every** key on the GitHub
   account, which may be broader than the owner intends for box access, and it
   makes GitHub an authority over box login. Until then, the owner adds the
   key by hand after first connect.

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
