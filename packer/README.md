# termag box AMI

Builds an Ubuntu 24.04 arm64 AMI with everything a termag box needs at
runtime. The resulting AMI is consumed by the Terraform module that
provisions per-user boxes.

The image bakes a **full devbox toolset** — `scripts/setup.sh` installs the
language toolchains, agent CLIs and dev tooling, so an agent on a box has the
same capabilities a human gets on a workstation.

## What's in the image

- **System / dev tooling**: `git`, `mosh`, `tmux`, `build-essential`, `curl`,
  `wget`, `jq`, `htop`, `ripgrep`, `zsh`, `zoxide`, `keychain`,
  `postgresql-client`, `rsync`, `neovim` (latest), `gh`, `awscli` v2,
  `terraform`, Doppler CLI, Docker (ce + buildx + compose), Chromium (snap).
- **Language toolchains (per-user, under `~termag`)**:
  - Node via **nvm** (LTS) + `corepack` (yarn, pnpm). *nvm-only — there is no
    system node; the agent service sources nvm.*
  - Go via **goenv** (1.26.1) with telemetry off
    (`~/.config/go/telemetry/mode`).
  - Python via **pyenv** (3.13). The interpreter is a
    python-build-standalone build fetched by `uv` and symlinked into
    `~/.pyenv/versions`, not compiled by `pyenv install` (which still works
    on the box for other versions). `poetry` is `uv tool install poetry`:
    that interpreter is marked externally managed, so `pip install` fails.
    Its stdlib is precompiled at install, as `make install` does, so a later
    import writes no `__pycache__` into the baked home.
  - Rust via **rustup**/`cargo`.
  - `uv` (Astral).
- **Agent CLIs**: `claude` + `codex` + `pi` (npm-global under nvm), `cursor`
  (`cursor-agent` binary, vendor installer), `devin` (vendor installer).
- **Extra tools**: `rtk` (pinned, digest-checked
  release binary from `github.com/rtk-ai/rtk`, in `~/.local/bin`),
  `browser-harness` (uv tool — needs Chromium + per-user CDP/VNC wiring),
  `clickhousectl` (best-effort).
- **Dotfiles** (devbox parity): `.zshrc` (wires every toolchain onto PATH for
  interactive tmux panes), `.tmux.conf` + TPM, `.gitconfig`, Oh My Zsh, neovim config.
- termag source — this checkout with full history, cloned from a bundle to `~termag/src/termag` (agent's `node_modules` baked in)
- agent-wiki pre-cloned to `~termag/src/agent-wiki`
- `termag` unix user (zsh shell, `docker` + `sudo` groups, linger enabled).
  Passwordless sudo via a group-keyed `/etc/sudoers.d/90-termag-box` policy so
  the box owner can install their own tooling; the group keying (not a
  username) means it survives the `termag` → owner rename at launch.
- `termag-agent.service` (from `deploy/`) installed at
  `~termag/.config/systemd/user/`, **not** enabled. Cloud-init enables it
  after dropping the bearer token at instance launch.
- `TERMAG_BOX=1` on every process: `/etc/profile.d/termag-box.sh` for bash
  login shells and a line in `/etc/zsh/zshenv` for zsh, the box user's shell
  (`box-lib.sh`, `install_box_marker`, written by full and incremental bakes),
  and `Environment=TERMAG_BOX=1` in `termag-agent.service`
  for everything the agent spawns (project panes, Claude runner sessions, a
  detached `make dev`), repeated per session as `new-session -e` so a tmux
  server that outlived an agent restart is covered too (`agent/tmux-args.js`).
  Tools that want to know they run on a termag box read it; the hostname is
  no signal.
- **Home-path index** (`scripts/index-home-paths.sh`, the last provisioner):
  `/var/lib/termag-bake/home-paths/` lists every symlink under `~termag` whose
  target is inside the home and every text file under the toolchain dirs that
  embeds `/home/termag`, and `/usr/local/sbin/termag-rewrite-home-paths`
  (`scripts/rewrite-home-paths.sh`) is what cloud-init runs after the
  `termag` → owner rename to fix exactly those entries. It replaces a
  boot-time walk of the whole home that took 4.5–15.5 minutes on a lazily
  restored EBS volume. Anything a provisioner writes under `~termag` *after*
  the index is not rewritten at boot, so new bake steps go before it.
- SSM agent (Canonical ships it) — provides the only inbound access path.
  No SSH lane is opened.
- `tpm2-tools` — userspace for the NitroTPM device (see below).

## NitroTPM (TPM 2.0)

Every box exposes a TPM 2.0 device (`/dev/tpm0` + `/dev/tpmrm0`) so on-box
utilities can use it — LUKS via `systemd-cryptenroll --tpm2-device=auto`, Vault
instance attestation, Linux IMA, or sealing secrets to PCR state with
`tpm2_create`/`tpm2_unseal`.

NitroTPM is an **AMI attribute** (`TpmSupport=v2.0` + `BootMode=uefi`), not a
launch flag — instances inherit it automatically, so neither `terraform/box/`
nor the SDK box provisioner needs any change. Two things make it work:

- **boot mode** is `uefi` — free here, since arm64/Graviton is UEFI-native.
- **`TpmSupport=v2.0`** can only be set via the `RegisterImage` API. Packer's
  `amazon-ebs` builder bakes the image with `CreateImage`, which has **no** way
  to set it. So the build tags its output `Component=box-base` and a
  `shell-local` post-processor (`scripts/enable-nitrotpm.sh`) re-registers the
  baked root snapshot with `--boot-mode uefi --tpm-support v2.0`, moves the
  `Component=box` discovery tag onto the NitroTPM image, and deregisters the
  intermediate. The re-register runs on the host running packer and needs the
  AWS CLI v2 + `jq` plus `ec2:RegisterImage`/`CreateTags`/`DeregisterImage`.

  > If the re-register step fails, no `Component=box` AMI is produced for that
  > build — discovery falls back to the last good one, never to a TPM-less box.

Verify inside a launched box (over SSM):

```bash
ls -l /dev/tpm0 /dev/tpmrm0       # devices present
sudo tpm2_pcrread                 # populated PCRs => measured boot feeding the TPM
sudo tpm2_getcap properties-fixed
```

The supported instance-type list (Graviton t4g/m6g–m9g/c6g–c8g/r6g–r8g, etc.)
is in `terraform/box/variables.tf`. **NitroTPM caveat:** its state is
instance-local — not in EBS snapshots, VM Import/Export, or the console — so
anything sealed to the TPM is bound to that one instance and won't survive a
relaunch. For durable key custody, pair the TPM (attestation) with KMS (key
material) rather than sealing secrets to PCRs alone.

## What's NOT in the image (per-user / set at launch)

- The bearer token (`~termag/src/termag/agent/agent.config.json`)
- Any per-project repo clones
- `gh auth`, `claude` login, `cursor`/`devin`/`pi` login, etc. — done by the
  user on first project use
- **MCP servers** — configured per-user in the user's Claude config with their
  own auth; not baked.
- **browser-harness CDP / VNC wiring** — the binary + Chromium are baked, but
  the headless-Chrome-over-CDP setup is per-user.

## Publishing a new AMI (the "Publish AMI" job) — recommended

> The GitHub Actions workflows this README describes (`publish-ami.yml`,
> `ami-retention.yml`) are part of the internal deployment and are not shipped
> in this repository; the pattern is documented so you can reproduce it.
> "Building locally" below needs nothing extra.

New boxes are launched from the **newest AMI tagged `App=termag,
Component=box`** (the box provisioner and `terraform/box` both discover by
that tag). So "ship a change to boxes" means "bake a new box AMI" — editing
`scripts/setup.sh` alone does nothing until an AMI is rebuilt.

**On `main`, that happens by itself.** `.github/workflows/publish-ami.yml`
runs hourly (`:17`). Its `check-box-ami` job reads the `TermagSha` tag off the
newest published box AMI and diffs that commit against `main` over the inputs
that land in the image: `box.pkr.hcl`, every file and script it ships (read
from the template, so a new `provisioner "file"` is covered automatically),
`agent/`, and the workflow itself. If anything changed, or the full bake at the
root of the image's chain is older than `BOX_AMI_MAX_AGE_DAYS` (7, so the
Ubuntu base and the npm-installed CLIs cannot drift indefinitely), `build-box`
bakes; otherwise the run costs one `DescribeImages` call. The run's step
summary shows which commit the live AMI came from, which inputs were
considered, the decision, and whether the bake was full or incremental (next
section). Merging is enough — the next box provisioned after the bake finishes
gets the change.

## Bake modes and the scratch volume

A bake is mostly waiting for EBS. Most of a full bake is Packer's "Waiting for AMI to become ready",
which is EBS copying every block the bake ever wrote to the root volume.
Two things cut that down.

**Incremental bakes.** `build-box` resolves a *bake mode* per run (the
"Resolve the bake mode" step; `bake_mode` at dispatch forces it):

- **full** — from Canonical's Ubuntu image, every provisioner runs. Chosen
  when there is no published box image to start from, when
  `packer/box.pkr.hcl` or `scripts/setup.sh` changed since the chain's last
  full bake, or when that full bake is over `BOX_AMI_MAX_AGE_DAYS` old.
- **incremental** — from the newest published `Component=box` image
  (`source_ami`). `scripts/refresh-box.sh` re-clones the termag bundle,
  reinstalls the `deploy/` artifacts and records the new `TermagSha`;
  `setup.sh` exits at once. A volume restored from a snapshot snapshots incrementally,
  so the "Waiting for AMI" phase covers a day's delta, not the toolchain.

Every image carries `BakeMode`, `SourceAmi`/`SourceAmiName`, and
`BaseTermagSha`/`BaseBakedAt` — the commit and time of the full bake at the
root of its chain, copied through each incremental bake. The staleness check
and the age rule read `BaseBakedAt`, so a chain re-roots on a fresh Ubuntu
image weekly whatever else happens. An incremental bake never runs
`setup.sh`, so toolchain changes (a new CLI, an apt package) reach boxes on
the next full bake, which a change to `setup.sh` itself triggers.

**Scratch volume.** `box.pkr.hcl` attaches a second gp3 volume and excludes
it from the AMI (`ami_block_device_mappings` with `no_device = true`, which
CreateImage honours). `scripts/prepare-scratch.sh` (first provisioner)
formats and mounts it and points bazel's output root (`/etc/bazel.bazelrc`,
a startup option, for repos that build with bazel on the box) and apt's
archives at it; `scripts/detach-scratch.sh`
removes both redirects, refuses to bake if anything under the home still
points at the mount, and unmounts before the home-path index runs. EBS has
no TRIM, so a file written and deleted on the root volume still ships in the
snapshot — a bazel output base and the apt archives are the big ones. `scripts/bake-mode.test.sh` checks the wiring (provisioner order, the
omitted mapping, the two scripts agreeing on paths, the workflow passing the
mode down).

> The termag source on a box is this checkout, not a remote clone:
> `scripts/bundle-source.sh` bundles the commit being baked (full history, no
> credentials, nothing untracked) and `setup.sh` clones it to
> `~termag/src/termag`, failing the bake if its HEAD is not the commit the
> AMI's `TermagSha` will name. That is why `agent/` is an input to the
> staleness check. After the bake, `build-box` waits for the published AMI and
> fails unless it carries `Component=box` and this run's `TermagSha` — a green
> run means delivery.

To bake on demand — a branch, another account, or now rather than at `:17` —
the same workflow runs by hand. It does the same `packer build` below against
AWS via OIDC, so no local Packer or long-lived creds are needed. **A manual
box bake is a candidate unless you tick `publish`**: it is tagged
`Component=box-candidate`, which discovery ignores, so you can bake a branch
and inspect the image without it becoming what new boxes launch from.

1. **GitHub → Actions → "Publish AMI" → Run workflow.**
2. Pick the **branch/ref** to bake (usually `main`). Packer ships *that*
   checkout into the image — `scripts/setup.sh`, the `deploy/` files, and the
   termag source itself — so the AMI reflects the ref you choose.
3. Set **`target`**:
   - `box` — bake only the per-user box AMI (this image).
   - `orchestrator` — bake only the control-plane server AMI.
   - `both` (default) — bake both.
4. Tick **`publish`** if the result should become the live box image
   (`Component=box`). Leave it off to get a `box-candidate`; the run's
   *Verify the published AMI* summary prints the `create-tags` one-liner
   that promotes a candidate to `box` later.
5. Leave the other inputs blank to build in the account the orchestrator runs
   in, which is where the box image has to be: the provisioner discovers AMIs
   with `Owners: ['self']`, so an image baked anywhere else is invisible to
   the orchestrator. The blank overrides resolve to the
   `ORCHESTRATOR_PACKER_*` repo Variables; a missing one fails the run rather
   than falling back to another account. To build elsewhere, set
   `aws_role_arn` / `region` / `vpc_id` / `subnet_id` / `instance_profile`
   together at dispatch — see the header comment in `publish-ami.yml`.

When it finishes with `publish` on it registers a fresh `Component=box` AMI.
**The next box provisioned picks it up automatically.** Already-running boxes are *not*
updated — they keep whatever AMI was newest at their launch time; re-provision
a box to move it onto the new image.

> Common gotcha: the job used to be called "Publish orchestrator AMI" and
> only baked the orchestrator, so running it did nothing for boxes. It now
> bakes either or both via `target` — make sure `target` is `box` or `both`.

### Building locally (fallback / debugging)

Requires Packer, valid AWS credentials (an Okta-SSO session works), and
network access from the dev VPC's public subnet for `apt`/`npm`.

```bash
cd packer/
packer init box.pkr.hcl        # per-template: `packer init .` errors on
                               # duplicate vars shared with orchestrator.pkr.hcl
packer build \
  -var vpc_id=<dev-vpc> \
  -var subnet_id=<public-subnet> \
  box.pkr.hcl
```

Build runs in `us-east-1`, in a VPC and public subnet you supply via
`-var vpc_id=...` and `-var subnet_id=...` (or a `tfvars`-style file).
Communication is via SSM, so the subnet needs outbound but not inbound
network access.

Successful build prints an AMI ID (`ami-...`); newly provisioned boxes
discover it by tag as described above.

## Iterating

A full bake spends most of its time provisioning (`apt upgrade`, the
toolchains, the npm global installs) and EBS snapshotting. An incremental bake skips `setup.sh` and
snapshots only the delta. The `setup.sh` provisioner timeout is 45m. When
tweaking the install script:

- Don't edit `box.pkr.hcl` for install changes — touch
  `scripts/setup.sh` instead. Either change makes the next scheduled bake a
  full one.
- The `termag-agent.service` lives in `deploy/`, not here.
- For a quick "is the script broken" check, launch a `t4g.medium`
  manually from the same Ubuntu 24.04 arm64 base AMI, attach the SSM
  profile, and run the script via `aws ssm send-command`.

## Known quirks

- **Packer can hang after the AMI is ready.** SSM-communicator builds
  sometimes wedge in the final "Waiting for AMI to become ready"
  polling loop even after `aws ec2 describe-images` shows `available`.
  Check directly with the AWS CLI; if the AMI is available, the
  artifact is good — kill Packer with `kill -9` and terminate any
  leftover `Component=ami-build`-tagged EC2 instances. The temporary
  keypair + security group will need manual deletion only if Packer
  didn't reach its cleanup phase.

- **`run_tags` ended up on the AMI** instead of the AMI-specific
  `tags` block in the first build — minor cosmetic issue, doesn't
  affect functionality. Fixable in a follow-up build by adjusting
  the source block's tag/run_tags split.

## Cleanup

Packer auto-terminates its build instance and removes the temporary
keypair. Images and snapshots are collected nightly by
the `ami-retention.yml` workflow (internal, see above) —
nothing here has to be pruned by hand, and the console is the wrong place
to do it (deregistering an image before reading its snapshot ids is how a
snapshot becomes unreachable).

The sweep keeps the newest 3 `available` images **per component**
(`orchestrator`, `box`, `box-candidate`), everything an instance is running
on, everything tagged `Retain=true`, and everything under 24 hours old. A
component that has keep-N at all always keeps **at least two** available
images, so a bad newest bake always has a historical one to fall back to.
Then it deletes every snapshot it can prove is termag's and that no
still-registered AMI references. Deleting the snapshot an incremental bake
started from is safe once that source image is gone: EBS keeps the blocks a
child snapshot still references.

"Can prove" means the snapshot is tagged `App=termag` — which
`snapshot_tags` now sets at bake time, and which the sweep backfills onto the
snapshots of registered termag AMIs so the evidence outlives the image. EC2's
generic `Created by CreateImage(...)` description is **not** proof: it is
written for every caller in the account, so a snapshot of yours whose AMI has
been deregistered looks exactly like a termag orphan. Those are listed in the
run summary and left alone unless someone dispatches the workflow with
`include_untagged_backlog` after reading that list.

`Component=box-base` and `Component=ami-build` are the exceptions to keep-N.
They get none, only the 24-hour floor. A successful build deregisters the
box-base intermediate, so one that is still around died before the NitroTPM
re-register. An ami-build image is what a timed-out ImageAvailable wait leaves
behind. Packer never reaches StepCreateTags, and the image keeps `run_tags`.

To hold an image the sweep would otherwise collect — a rollback target older
than keep-3, and a prerequisite for pinning `orchestrator_ami_id` at it:

```bash
aws ec2 create-tags --resources <ami> --tags Key=Retain,Value=true
```

To see what the sweep would do without doing it: Actions → "AMI retention" →
Run workflow, leave `dry_run` ticked, read the run summary.
