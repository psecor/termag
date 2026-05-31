# termag box (Terraform)

Provisions a single termag box from the AMI built by `packer/`. The
backend will eventually drive this from code; for now it's runnable
directly via `terraform apply` for manual smoke tests.

## What it creates

- One EC2 instance from the termag-box AMI (arm64 / Graviton)
- One security group (egress-only, no inbound — SSM tunnels via outbound)
- No public IP — outbound goes through the dev VPC's existing NAT GWs;
  SSM works because the VPC has SSM/SSMmessages/EC2messages endpoints
- IMDSv2 required on the instance metadata service

## Inputs (no defaults)

| Variable | Notes |
|---|---|
| `box_name` | Used in tags + SG name (`termag-box-<name>`) |
| `owner` | Email — for tagging |
| `agent_bearer_token` | From the termag UI's "Agent Tokens" page |
| `git_user_email` | `git config user.email` for the termag user |
| `git_user_name` | `git config user.name` for the termag user |

Other variables (AMI, VPC, subnet, instance type, etc.) have sensible
defaults baked from our environment investigation — see `variables.tf`.

## Usage

```bash
terraform -chdir=terraform/box init

terraform -chdir=terraform/box apply \
  -var box_name=ami-test-1 \
  -var owner=you@example.com \
  -var agent_bearer_token="$TOKEN" \
  -var git_user_email=you@example.com \
  -var git_user_name="Your Name"
```

Or via a tfvars file (`box.auto.tfvars`, **gitignored**):

```hcl
box_name           = "ami-test-1"
owner              = "you@example.com"
agent_bearer_token = "tmag_..."
git_user_email     = "you@example.com"
git_user_name      = "Your Name"
```

The provider needs AWS credentials. AWS SSO sessions work via:

```bash
eval "$(aws configure export-credentials --format env)"
```

(SSO session creds are temporary — re-export if `terraform apply`
errors with "no valid credentials".)

## Verifying after apply

```bash
INSTANCE_ID=$(terraform -chdir=terraform/box output -raw instance_id)

# Wait for SSM agent to come up
while [ "$(aws ssm describe-instance-information \
    --region us-east-1 \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query 'InstanceInformationList[0].PingStatus' --output text)" != "Online" ]; do
  echo "waiting..."; sleep 8
done

# Shell in
aws ssm start-session --region us-east-1 --target "$INSTANCE_ID"
# inside: sudo -iu termag, then tail /var/log/termag-cloudinit.log
```

The cloud-init log is at `/var/log/termag-cloudinit.log` — that's the
first place to look if the agent isn't connecting.

## Tearing down

```bash
terraform -chdir=terraform/box destroy
```

(Don't terminate by hand if Terraform manages the instance — `destroy`
removes the SG too.)

## Known limitations (V1)

- One instance per state. To run multiple boxes for the same user, use
  Terraform workspaces or copy the directory. The backend (Task E)
  will eventually drive multiple instances via per-box state.
- No EBS-backed persistent home dir — each box is ephemeral.
- Changing `agent_bearer_token` (or any user-data input) replaces the
  instance. Tmux state is lost. Per design for V1.
- No IPv6.
