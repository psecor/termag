# termag box AMI

Builds an Ubuntu 24.04 arm64 AMI with everything a termag box needs at
runtime. The resulting AMI is consumed by the Terraform module that
provisions per-user boxes.

## What's in the image

- System: `git`, `tmux`, `build-essential`, `curl`, `jq`, `python3`,
  `nodejs` (LTS), `gh`, `awscli`, `postgresql-client`
- Agent CLIs: `claude` (npm, system-wide), `cursor` (`agent` binary,
  vendor installer run as the `termag` user), `devin` (vendor installer
  run as the `termag` user). No `codex`, `gemini`, `auggie`, or `vibe`
  in V1 (no licenses).
- termag source pre-cloned to `~termag/src/termag` (agent's `node_modules` baked in)
- agent-wiki pre-cloned to `~termag/src/agent-wiki`
- `termag` unix user with linger enabled
- `termag-agent.service` (from `deploy/`) installed at
  `~termag/.config/systemd/user/`, **not** enabled. Cloud-init enables it
  after dropping the bearer token at instance launch.
- SSM agent (Canonical ships it) — provides the only inbound access path.
  No SSH lane is opened.

## What's NOT in the image (set at launch)

- The bearer token (`~termag/.config/termag/agent.config.json`)
- Any per-project repo clones
- `gh auth`, `claude` login, etc. — done by the user on first project use

## Build

Requires Packer, valid AWS credentials (an Okta-SSO session works), and
network access from the dev VPC's public subnet for `apt`/`npm`.

```bash
cd packer/
packer init .
packer build box.pkr.hcl
```

Build runs in `us-east-1`, in a VPC and public subnet you supply via
`-var vpc_id=...` and `-var subnet_id=...` (or a `tfvars`-style file).
Communication is via SSM, so the subnet needs outbound but not inbound
network access.

Successful build prints an AMI ID (`ami-...`); that gets handed to the
Terraform module as a variable.

## Iterating

The bake takes ~5–10 minutes most of which is `apt upgrade`. When
tweaking the install script:

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
