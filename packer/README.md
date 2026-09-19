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
  - Go via **goenv** (1.26.1).
  - Python via **pyenv** (3.13) + `poetry`.
  - Rust via **rustup**/`cargo`.
  - `uv` (Astral).
- **Agent CLIs**: `claude` + `codex` (npm-global under nvm), `cursor`
  (`cursor-agent` binary, vendor installer), `devin` (vendor installer).
- **Extra tools**: `rtk` (cargo-built from
  `github.com/rtk-ai/rtk`), `browser-harness` (uv tool — needs Chromium +
  per-user CDP/VNC wiring), `clickhousectl` (best-effort).
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
- `gh auth`, `claude` login, `cursor`/`devin` login, etc. — done by the user
  on first project use
- **MCP servers** — configured per-user in the user's Claude config with their
  own auth; not baked.
- **browser-harness CDP / VNC wiring** — the binary + Chromium are baked, but
  the headless-Chrome-over-CDP setup is per-user.

## Publishing a new AMI (the "Publish AMI" job) — recommended

> The GitHub Actions workflow this section describes is part of the internal
> deployment and is not shipped in this repository; the pattern is documented
> so you can reproduce it. "Building locally" below needs nothing extra.

New boxes are launched from the **newest AMI tagged `App=termag,
Component=box`** (the box provisioner and `terraform/box` both discover by
that tag). So "ship a change to boxes" means "bake a new box AMI" — editing
`scripts/setup.sh` alone does nothing until an AMI is rebuilt.

**On `main`, that happens by itself.** `.github/workflows/publish-ami.yml`
runs hourly (`:17`). Its `check-box-ami` job reads the `TermagSha` tag off the
newest published box AMI and diffs that commit against `main` over the inputs
that land in the image: `box.pkr.hcl`, every file and script it ships (read
from the template, so a new `provisioner "file"` is covered automatically),
`agent/`, and the workflow itself. If anything changed, or the image is older
than 14 days (so the Ubuntu base and the npm-installed CLIs cannot drift
indefinitely), `build-box` bakes; otherwise the run costs one `DescribeImages`
call. The run's step summary shows which commit the
live AMI came from, which inputs were considered, and the decision. Merging is
enough — the next box provisioned after the bake finishes gets the change.

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
5. Leave the other inputs at their defaults to build in the workflow's default
   account. To build elsewhere, set `aws_role_arn` / `vpc_id` / `subnet_id`
   at dispatch.

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

The bake now takes ~25–40 minutes (the full toolchain set: `apt upgrade`,
compiling a CPython via pyenv, the Rust toolchain + cargo-building rtk, npm
global installs). The packer shell provisioner timeout is 45m. When tweaking
the install script:

- Don't edit `box.pkr.hcl` for install changes — touch
  `scripts/setup.sh` instead.
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
keypair. The resulting AMI accumulates over builds; prune old ones via:

```bash
aws ec2 describe-images --owners self --region us-east-1 \
  --filters "Name=tag:App,Values=termag" "Name=tag:Component,Values=box" \
  --query 'sort_by(Images, &CreationDate)[*].[ImageId,Name,CreationDate]' \
  --output table
# then:
aws ec2 deregister-image --image-id <old-ami> --region us-east-1
```

A successful build leaves only the NitroTPM image (`Component=box`); the
intermediate is deregistered for you. A **failed** re-register can orphan a
`Component=box-base` image — list and prune those the same way with
`Values=box-base`. (`deregister-image` never deletes snapshots; prune stray
snapshots separately if needed.)
