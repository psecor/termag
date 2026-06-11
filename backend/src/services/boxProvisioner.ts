/**
 * Box provisioner — orchestrator-driven EC2 box lifecycle via the AWS SDK.
 *
 * This is the V2 bridge described in docs/box-provisioning.md: instead of
 * handing the user a bearer token to paste into `terraform apply`, the backend
 * launches the box itself under a locked-down IAM grant (a locked blast
 * radius — per-box role + permissions boundary, tag-scoped EC2, ALB ingress).
 *
 * The shape we re-create here mirrors terraform/box/ exactly (egress-only SG,
 * IMDSv2 instance, the cloudinit.sh.tftpl wiring) — that module is the spec we
 * port from. The AMI is discovered by tag (App=termag, Component=box), so a
 * freshly-baked image is picked up with no redeploy.
 *
 * provisionBox() is fire-and-forget from the route's perspective: POST returns
 * `provisioning` immediately and the box flips to `ready` on its own when its
 * agent dials the WS (see agentRegistry.registerAgent). On any SDK error the
 * Instance is marked `failed` with provisioningError set.
 */

import {
  EC2Client,
  DescribeImagesCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand,
  DeleteSecurityGroupCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  type Tag,
} from '@aws-sdk/client-ec2';
import {
  IAMClient,
  CreateRoleCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  CreateInstanceProfileCommand,
  AddRoleToInstanceProfileCommand,
  RemoveRoleFromInstanceProfileCommand,
  DeleteInstanceProfileCommand,
  DeleteRoleCommand,
} from '@aws-sdk/client-iam';
import { Instance, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SSM_CORE_POLICY_ARN = 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore';
const GIT_TOKEN_INLINE_POLICY = 'termag-git-token-read';

// ── Config (from backend/.env, mostly outputs from your IAM-grant Terraform) ─

interface BoxConfig {
  region: string;
  agentWsUrl: string;          // wss://<host>/termag/ws/agent
  resourcePrefix: string;      // e.g. "termag-box" — SG/role/profile name prefix
  permissionsBoundaryArn: string;
  vpcId: string;
  subnetId: string;
  instanceType: string;        // MUST be arm64/Graviton — the AMI is arm64-only
  albSecurityGroupId: string;
  managedTag: string;          // ManagedBy tag value the grant scopes on
  rootVolumeGb: number;
  gitTokenSecretArn?: string;  // optional: private-repo PAT, read at boot via SSM/SM
}

/**
 * Reads box config from the environment. Returns null when the feature is not
 * configured (local dev, or a deploy that hasn't surfaced the module outputs
 * into the secret yet) so callers can fall back to the manual-terraform path.
 */
export function getBoxConfig(): BoxConfig | null {
  const region = process.env.AWS_REGION;
  const agentWsUrl = process.env.AGENT_WS_URL;
  const resourcePrefix = process.env.BOX_RESOURCE_PREFIX;
  const permissionsBoundaryArn = process.env.BOX_PERMISSIONS_BOUNDARY_ARN;
  const vpcId = process.env.BOX_VPC_ID;
  const subnetId = process.env.BOX_SUBNET_ID;
  const albSecurityGroupId = process.env.ALB_SECURITY_GROUP_ID;

  if (!region || !agentWsUrl || !resourcePrefix || !permissionsBoundaryArn ||
      !vpcId || !subnetId || !albSecurityGroupId) {
    return null;
  }

  return {
    region,
    agentWsUrl,
    resourcePrefix,
    permissionsBoundaryArn,
    vpcId,
    subnetId,
    albSecurityGroupId,
    instanceType: process.env.BOX_INSTANCE_TYPE ?? 't4g.medium',
    managedTag: process.env.BOX_MANAGED_TAG ?? 'termag-box',
    rootVolumeGb: parseInt(process.env.BOX_ROOT_VOLUME_GB ?? '30', 10),
    gitTokenSecretArn: process.env.BOX_GIT_TOKEN_SECRET_ARN || undefined,
  };
}

export function isBoxProvisioningConfigured(): boolean {
  return getBoxConfig() !== null;
}

// ── Cloud-init (TS port of terraform/box/cloudinit.sh.tftpl) ─────────────────

export interface CloudInitVars {
  termagUrl: string;       // AGENT_WS_URL
  agentToken: string;      // raw tmag_ token (only sensitive value in user_data)
  gitUserEmail: string;
  gitUserName: string;
  remoteUnixUser: string;  // user's unix username; path_remap rewrites it to termag
}

/**
 * Build the box's first-boot cloud-init. Ported from
 * terraform/box/cloudinit.sh.tftpl — keep the two in sync.
 *
 * The AMI bakes a placeholder `termag` Unix user with the agent + CLIs
 * pre-installed. We rename it here to the box owner's actual Unix
 * username, so the agent runs as that user under /home/<user>/ — no
 * path_remap hack required, and the user owns their own dotfiles/shell.
 *
 * SECURITY: the only secret in user_data is the per-box agent bearer token.
 * It carries zero AWS authority — the box's blast radius is governed entirely
 * by the instance role + permissions boundary (a separate credential this
 * token can't touch). The same token also lives on-box in agent.config.json,
 * which the agent must read anyway, so user_data is no weaker. See the security
 * analysis in docs/box-provisioning.md.
 */
export function buildCloudInit(v: CloudInitVars): string {
  // The agent.config.json payload. JSON.stringify keeps the token safely quoted.
  // No path_remap — after the rename, paths match end to end.
  const agentConfig = JSON.stringify({
    termag_url: v.termagUrl,
    token: v.agentToken,
  }, null, 2);

  return `#!/bin/bash
# termag box first-boot wiring (generated by boxProvisioner.ts).
# Ported from terraform/box/cloudinit.sh.tftpl.
set -euo pipefail

exec > >(tee /var/log/termag-cloudinit.log) 2>&1
echo "=== termag box cloud-init starting at $(date -Iseconds) ==="

UNIX_USER=${shellQuote(v.remoteUnixUser)}

# ── Step 1: terminate any running termag processes + drop linger ─────────
# Linger may have spawned a user-manager already (the AMI bake enabled it),
# which blocks usermod -l on a user with running processes.
loginctl terminate-user termag 2>/dev/null || true
loginctl disable-linger termag 2>/dev/null || true
sleep 2
if pgrep -u termag >/dev/null; then
  echo "ERROR: termag still has running processes after terminate:"
  pgrep -u termag -a
  exit 1
fi

# ── Step 2: rename user + group, move home ───────────────────────────────
usermod -l "$UNIX_USER" -d "/home/$UNIX_USER" -m termag
groupmod -n "$UNIX_USER" termag
USER_UID=$(id -u "$UNIX_USER")

# ── Step 3: rewrite absolute symlinks under the renamed home ─────────────
# cursor-agent and devin installers create symlinks with /home/termag/
# baked into the target. After usermod the home moved but symlink targets
# didn't follow; rewrite mechanically.
find "/home/$UNIX_USER" -type l -lname '/home/termag/*' | while read link; do
  target=$(readlink "$link")
  newtarget=$(echo "$target" | sed "s|/home/termag|/home/$UNIX_USER|")
  ln -sfn "$newtarget" "$link"
done

# ── Step 4: rewrite text configs that reference /home/termag ─────────────
if [ -f "/home/$UNIX_USER/.config/devin/config.json" ]; then
  sed -i "s|/home/termag|/home/$UNIX_USER|g" "/home/$UNIX_USER/.config/devin/config.json"
fi

# ── Step 5: drop the agent's bearer token ────────────────────────────────
CONFIG_PATH="/home/$UNIX_USER/src/termag/agent/agent.config.json"
umask 077
cat > /tmp/agent.config.json <<'JSON'
${agentConfig}
JSON
install -o "$UNIX_USER" -g "$UNIX_USER" -m 600 /tmp/agent.config.json "$CONFIG_PATH"
rm -f /tmp/agent.config.json

# ── Step 6: per-user git identity ────────────────────────────────────────
export TERMAG_GIT_EMAIL=${shellQuote(v.gitUserEmail)}
export TERMAG_GIT_NAME=${shellQuote(v.gitUserName)}
sudo -u "$UNIX_USER" -H git config --global user.email "$TERMAG_GIT_EMAIL"
sudo -u "$UNIX_USER" -H git config --global user.name  "$TERMAG_GIT_NAME"

# ── Step 7: re-enable linger under the new name ──────────────────────────
loginctl enable-linger "$UNIX_USER"
sleep 2

# ── Step 8: enable + start the agent ─────────────────────────────────────
sudo -u "$UNIX_USER" XDG_RUNTIME_DIR=/run/user/$USER_UID systemctl --user daemon-reload
sudo -u "$UNIX_USER" XDG_RUNTIME_DIR=/run/user/$USER_UID systemctl --user enable --now termag-agent.service

# ── Sanity check (don't fail the boot on a slow first dial) ──────────────
sleep 2
sudo -u "$UNIX_USER" XDG_RUNTIME_DIR=/run/user/$USER_UID systemctl --user is-active termag-agent.service || true

echo "=== termag box cloud-init complete at $(date -Iseconds) ==="
`;
}

// POSIX single-quote escaping for embedding an arbitrary string in shell.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ── Provisioning ─────────────────────────────────────────────────────────────

export interface ProvisionArgs {
  instance: Instance;
  boxName: string;
  owner: string;          // owner email (tags / audit)
  token: string;          // raw agent bearer token
  remoteUnixUser: string;
  gitUserEmail: string;
  gitUserName: string;
}

/**
 * Launch the box. Best-effort: marks the Instance `failed` (with
 * provisioningError) on any error. Never throws to the caller — the route
 * fires this un-awaited.
 */
export async function provisionBox(args: ProvisionArgs): Promise<void> {
  const cfg = getBoxConfig();
  if (!cfg) {
    await markFailed(args.instance.id, 'box provisioning not configured (missing AWS_REGION / BOX_* env)');
    return;
  }

  // Globally-unique physical name (box names are only unique per user). Still
  // matches the grant's `<prefix>-*` resource condition. Human-readable detail
  // lives in the Owner/BoxName tags.
  const name = `${cfg.resourcePrefix}-${args.instance.id}`;
  const ec2 = new EC2Client({ region: cfg.region });
  const iam = new IAMClient({ region: cfg.region });

  const tags: Tag[] = [
    { Key: 'Name', Value: name },
    { Key: 'App', Value: 'termag' },
    { Key: 'ManagedBy', Value: cfg.managedTag },
    { Key: 'Owner', Value: args.owner },
    { Key: 'BoxName', Value: args.boxName },
  ];

  try {
    // 1. Newest box AMI by tag.
    const amiId = await discoverLatestAmi(ec2);

    // 2. Per-box egress-only SG (AWS adds the default allow-all egress rule).
    const sg = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: name,
      // SG descriptions must be ASCII-only — no em-dash here.
      Description: `termag box ${args.boxName} - outbound only, no inbound`,
      VpcId: cfg.vpcId,
      TagSpecifications: [{ ResourceType: 'security-group', Tags: [...tags, { Key: 'Component', Value: 'box-sg' }] }],
    }));
    const securityGroupId = sg.GroupId!;

    // 3. Let the box reach the orchestrator: 443 ingress on the ALB SG from
    //    the box SG (grant's Ec2BoxIngressToAlb).
    await authorizeAlbIngress(ec2, cfg.albSecurityGroupId, securityGroupId, args.boxName);

    // 4. Per-box IAM identity (role WITH the permissions boundary — denied
    //    otherwise) → SSM core → optional git-token read → instance profile.
    const iamRoleName = await createBoxRole(iam, name, cfg, tags);

    // 5. Persist the resource handles BEFORE RunInstances so terminateBox can
    //    always clean up, even if the launch itself fails midway.
    await prisma.instance.update({
      where: { id: args.instance.id },
      data: { region: cfg.region, securityGroupId, iamRoleName },
    });

    // 6. Launch.
    const userData = buildCloudInit({
      termagUrl: cfg.agentWsUrl,
      agentToken: args.token,
      gitUserEmail: args.gitUserEmail,
      gitUserName: args.gitUserName,
      remoteUnixUser: args.remoteUnixUser,
    });
    const ec2InstanceId = await runInstance(ec2, { amiId, name, securityGroupId, iamRoleName, userData, cfg, tags });

    // 7. Record the EC2 id + private DNS. Status stays `provisioning` until the
    //    agent dials in (registerAgent flips it to `ready`).
    const hostname = await describePrivateDns(ec2, ec2InstanceId);
    await prisma.instance.update({
      where: { id: args.instance.id },
      data: { ec2InstanceId, hostname },
    });

    console.log(`[BOX] Provisioned ${args.boxName} → ${ec2InstanceId} (sg=${securityGroupId}, role=${iamRoleName})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[BOX] Provisioning failed for ${args.boxName}:`, msg);
    await markFailed(args.instance.id, msg);
  }
}

async function discoverLatestAmi(ec2: EC2Client): Promise<string> {
  const res = await ec2.send(new DescribeImagesCommand({
    Filters: [
      { Name: 'tag:App', Values: ['termag'] },
      { Name: 'tag:Component', Values: ['box'] },
      { Name: 'state', Values: ['available'] },
    ],
    Owners: ['self'],
  }));
  const images = (res.Images ?? []).filter(i => i.CreationDate);
  if (images.length === 0) {
    throw new Error('No box AMI found (tag App=termag, Component=box). Run `packer build` first.');
  }
  images.sort((a, b) => (b.CreationDate! < a.CreationDate! ? -1 : 1));
  return images[0].ImageId!;
}

async function authorizeAlbIngress(ec2: EC2Client, albSgId: string, boxSgId: string, boxName: string): Promise<void> {
  await ec2.send(new AuthorizeSecurityGroupIngressCommand({
    GroupId: albSgId,
    IpPermissions: [{
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      UserIdGroupPairs: [{ GroupId: boxSgId, Description: `termag box ${boxName}` }],
    }],
  }));
}

async function createBoxRole(iam: IAMClient, name: string, cfg: BoxConfig, tags: Tag[]): Promise<string> {
  const assumeRolePolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { Service: 'ec2.amazonaws.com' },
      Action: 'sts:AssumeRole',
    }],
  });

  await iam.send(new CreateRoleCommand({
    RoleName: name,
    AssumeRolePolicyDocument: assumeRolePolicy,
    PermissionsBoundary: cfg.permissionsBoundaryArn,
    Description: `termag per-box role for ${name}`,
    Tags: tags.map(t => ({ Key: t.Key!, Value: t.Value! })),
  }));

  await iam.send(new AttachRolePolicyCommand({ RoleName: name, PolicyArn: SSM_CORE_POLICY_ARN }));

  if (cfg.gitTokenSecretArn) {
    await iam.send(new PutRolePolicyCommand({
      RoleName: name,
      PolicyName: GIT_TOKEN_INLINE_POLICY,
      PolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: 'secretsmanager:GetSecretValue',
          Resource: cfg.gitTokenSecretArn,
        }],
      }),
    }));
  }

  await iam.send(new CreateInstanceProfileCommand({ InstanceProfileName: name }));
  await iam.send(new AddRoleToInstanceProfileCommand({ InstanceProfileName: name, RoleName: name }));
  return name;
}

interface RunArgs {
  amiId: string;
  name: string;
  securityGroupId: string;
  iamRoleName: string;
  userData: string;
  cfg: BoxConfig;
  tags: Tag[];
}

async function runInstance(ec2: EC2Client, a: RunArgs): Promise<string> {
  const cmd = new RunInstancesCommand({
    ImageId: a.amiId,
    InstanceType: a.cfg.instanceType as any,
    MinCount: 1,
    MaxCount: 1,
    SubnetId: a.cfg.subnetId,
    SecurityGroupIds: [a.securityGroupId],
    IamInstanceProfile: { Name: a.iamRoleName },
    MetadataOptions: {
      HttpEndpoint: 'enabled',
      HttpTokens: 'required',          // IMDSv2 only
      HttpPutResponseHopLimit: 2,
    },
    BlockDeviceMappings: [{
      DeviceName: '/dev/sda1',
      Ebs: { VolumeSize: a.cfg.rootVolumeGb, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true },
    }],
    TagSpecifications: [
      { ResourceType: 'instance', Tags: [...a.tags, { Key: 'Component', Value: 'box' }] },
      { ResourceType: 'volume', Tags: [...a.tags, { Key: 'Component', Value: 'box-volume' }] },
    ],
    UserData: Buffer.from(a.userData).toString('base64'),
  });

  // Instance-profile creation is eventually consistent — RunInstances right
  // after AddRoleToInstanceProfile can fail with "Invalid IAM Instance
  // Profile". Retry a few times with backoff.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await ec2.send(cmd);
      const id = res.Instances?.[0]?.InstanceId;
      if (!id) throw new Error('RunInstances returned no instance id');
      return id;
    } catch (err) {
      lastErr = err;
      const name = err instanceof Error ? err.name : '';
      if (name === 'InvalidParameterValue' || name === 'InvalidIamInstanceProfile') {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('RunInstances failed');
}

async function describePrivateDns(ec2: EC2Client, instanceId: string): Promise<string | null> {
  try {
    const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const inst = res.Reservations?.[0]?.Instances?.[0];
    return inst?.PrivateDnsName || inst?.PrivateIpAddress || null;
  } catch {
    return null;
  }
}

async function markFailed(instanceId: string, error: string): Promise<void> {
  await prisma.instance.update({
    where: { id: instanceId },
    data: { status: 'failed', provisioningError: error.slice(0, 1000) },
  }).catch(e => console.error(`[BOX] Failed to mark instance ${instanceId} failed:`, e.message));
}

// ── Termination ──────────────────────────────────────────────────────────────

/**
 * Tear down a box's AWS resources. Best-effort and idempotent: each step is
 * guarded so a partially-provisioned box (or one already half-gone) still
 * cleans up as far as it can. Fired un-awaited by the terminate route.
 */
export async function terminateBox(instance: Instance): Promise<void> {
  const cfg = getBoxConfig();
  if (!cfg) return;

  const region = instance.region ?? cfg.region;
  const ec2 = new EC2Client({ region });
  const iam = new IAMClient({ region });
  const name = instance.iamRoleName ?? `${cfg.resourcePrefix}-${instance.id}`;

  // 1. Terminate the EC2 instance and wait for it to go away — the SG can't be
  //    deleted while an ENI references it.
  if (instance.ec2InstanceId) {
    try {
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instance.ec2InstanceId] }));
      await waitForTerminated(ec2, instance.ec2InstanceId);
    } catch (err) {
      console.error(`[BOX] terminate instance ${instance.ec2InstanceId} failed:`, errMsg(err));
    }
  }

  // 2. Revoke the ALB ingress rule, then delete the box SG.
  if (instance.securityGroupId) {
    try {
      await ec2.send(new RevokeSecurityGroupIngressCommand({
        GroupId: cfg.albSecurityGroupId,
        IpPermissions: [{
          IpProtocol: 'tcp', FromPort: 443, ToPort: 443,
          UserIdGroupPairs: [{ GroupId: instance.securityGroupId }],
        }],
      }));
    } catch (err) {
      console.error(`[BOX] revoke ALB ingress for ${instance.securityGroupId} failed:`, errMsg(err));
    }
    await deleteSgWithRetry(ec2, instance.securityGroupId);
  }

  // 3. Detach/delete the role + instance profile.
  if (instance.iamRoleName) {
    await safe(() => iam.send(new RemoveRoleFromInstanceProfileCommand({ InstanceProfileName: name, RoleName: name })));
    await safe(() => iam.send(new DeleteInstanceProfileCommand({ InstanceProfileName: name })));
    await safe(() => iam.send(new DetachRolePolicyCommand({ RoleName: name, PolicyArn: SSM_CORE_POLICY_ARN })));
    if (cfg.gitTokenSecretArn) {
      await safe(() => iam.send(new DeleteRolePolicyCommand({ RoleName: name, PolicyName: GIT_TOKEN_INLINE_POLICY })));
    }
    await safe(() => iam.send(new DeleteRoleCommand({ RoleName: name })));
  }

  console.log(`[BOX] Terminated box resources for ${instance.name}`);
}

async function waitForTerminated(ec2: EC2Client, instanceId: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      const state = res.Reservations?.[0]?.Instances?.[0]?.State?.Name;
      if (!state || state === 'terminated') return;
    } catch {
      return; // instance no longer describable — treat as gone
    }
    await sleep(5000);
  }
  // Give up waiting after ~5min; SG deletion below will retry on its own.
}

async function deleteSgWithRetry(ec2: EC2Client, sgId: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    try {
      await ec2.send(new DeleteSecurityGroupCommand({ GroupId: sgId }));
      return;
    } catch (err) {
      // DependencyViolation while the terminated ENI lingers — back off.
      if (i === 5) { console.error(`[BOX] delete SG ${sgId} failed:`, errMsg(err)); return; }
      await sleep(10000);
    }
  }
}

// ── Stuck-provisioning sweep ─────────────────────────────────────────────────

const STUCK_AFTER_MS = 15 * 60 * 1000; // 15 min with no agent → failed
let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Periodically flip boxes that have been `provisioning` for too long without
 * their agent ever dialing in to `failed`. (registerAgent flips healthy boxes
 * to `ready`, so anything still provisioning past the window is stuck.)
 */
export function startProvisioningSweep(intervalMs = 5 * 60 * 1000): void {
  if (sweepTimer) return;
  const tick = async () => {
    try {
      const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
      const stuck = await prisma.instance.updateMany({
        where: { status: 'provisioning', createdAt: { lt: cutoff } },
        data: { status: 'failed', provisioningError: 'Box never connected within 15 minutes of provisioning' },
      });
      if (stuck.count > 0) console.log(`[BOX] Swept ${stuck.count} stuck-provisioning box(es) → failed`);
    } catch (err) {
      console.error('[BOX] Provisioning sweep failed:', errMsg(err));
    }
  };
  sweepTimer = setInterval(tick, intervalMs);
  sweepTimer.unref?.();
}

export function stopProvisioningSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch (err) {
    // NoSuchEntity etc. are expected on idempotent re-runs — log at debug level.
    const name = err instanceof Error ? err.name : '';
    if (name !== 'NoSuchEntity' && name !== 'NoSuchEntityException') {
      console.error('[BOX] cleanup step failed:', errMsg(err));
    }
  }
}
