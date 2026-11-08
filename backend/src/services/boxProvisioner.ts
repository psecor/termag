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
 *
 * Deployment shapes. The orchestrator may run (a) on an EC2 host in the same
 * account as the boxes, using its instance role, or (b) as a container (k8s)
 * whose pod identity lives in another account. Two knobs cover both:
 *   - BOX_PROVISIONER_ROLE_ARN: when set, every AWS call is made with
 *     credentials from sts:AssumeRole on that role (the box account's
 *     provisioner role) on top of the ambient credential chain. Unset = use the
 *     ambient credentials directly (the EC2 instance-role shape).
 *   - HOST_SECURITY_GROUP_ID: the SG fronting the agent endpoint boxes dial
 *     back to. On EC2 it is the host's own SG and gets a :3040 ingress rule per
 *     box SG. Off-host (k8s ingress / internal LB with its own reachability
 *     rules) leave it unset and no SG rules are written at provision time.
 *     Teardown does NOT rely on it: terminateBox asks EC2 which SGs still
 *     reference the box SG in an ingress rule and revokes from every one of
 *     them, so boxes created by the EC2-hosted orchestrator are cleaned up by a
 *     container orchestrator that has RevokeSecurityGroupIngress on the old
 *     host SG (the terraform module exposes that grant separately from the
 *     box-SG permissions).
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
  DescribeSecurityGroupsCommand,
  DescribeInstanceTypesCommand,
  type Image,
  type EbsBlockDevice,
  type Tag,
} from '@aws-sdk/client-ec2';
import {
  IAMClient,
  CreateRoleCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  GetRolePolicyCommand,
  CreateInstanceProfileCommand,
  AddRoleToInstanceProfileCommand,
  RemoveRoleFromInstanceProfileCommand,
  DeleteInstanceProfileCommand,
  DeleteRoleCommand,
  ListRolePoliciesCommand,
} from '@aws-sdk/client-iam';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { Instance, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { OWNED_BOX_SELECT, type OwnedBoxRow } from './ownedBoxRow';
import { createHash, randomBytes } from 'crypto';
import { stuckWarmingReason, type StuckWarmingReason } from './warmPoolPlanner';
import {
  AMI_CHANNEL_TAG,
  type BoxImageSelection,
  PUBLISHED_IMAGE,
  boxImageSource,
  fallbackImageSource,
  pickSelectedImage,
  selectionKey,
} from './boxImage';
import { instanceTypesForSize, type BoxSize } from './boxSize';
import { MANAGED_BEGIN, MANAGED_END, managedBlock } from './sshKeys';
import { QUARANTINED, QUARANTINE_DENY_POLICY } from './boxQuarantinePolicy';
import { ownerAuthorizedKeyLines } from './sshKeySync';
import { BOX_SETUP_DIR, BOX_SETUP_FILE, isSetupOff } from './boxSetup';
import { flavorSpec, type BoxFlavor } from './boxFlavor';
import {
  EC2_GROUP_NOT_FOUND,
  EC2_INSTANCE_NOT_FOUND,
  EC2_PERMISSION_NOT_FOUND,
  FAILED_LAUNCH_SWEEP_BATCH,
  IAM_NOT_FOUND,
  TEARDOWN_SWEEP_BATCH,
  failedLaunchLeftoversWhere,
  isAwsNotFound,
  provisioningSweepIntervalMs,
  teardownCandidatesWhere,
  teardownRetryAfterMs,
} from './boxTeardownPolicy';
import {
  BOX_ECR_PULL_INLINE_POLICY,
  boxEcrPullPolicyDocument,
  ecrPullPolicyNeedsUpdate,
  parseBoxEcrPull,
  type BoxEcrPullConfig,
} from './boxEcrPolicy';
import { failRoot, rootSpan, traceSweep } from './tracing/spans';
import { boxVolumeInitRate, isVolumeInitRateRefusal } from './boxVolumeInitRate';
import { boxVolumePerformance, effectiveVolumePerformance, isVolumePerformanceRefusal, volumePerformanceFor, type VolumePerformance } from './boxVolumePerformance';
import { recordImageFloor } from './boxImageFloor';


const SSM_CORE_POLICY_ARN = 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore';
const GIT_TOKEN_INLINE_POLICY = 'termag-git-token-read';

// ── Config (from backend/.env, mostly outputs from your IAM-grant Terraform) ─

export interface BoxConfig {
  region: string;
  agentWsUrl: string;          // URL the box agent dials: ws(s)://<orchestrator>/termag/ws/agent
  resourcePrefix: string;      // e.g. "termag-box" — SG/role/profile name prefix
  permissionsBoundaryArn: string;
  vpcId: string;
  subnetId: string;
  fallbackSubnetIds: string[]; // with subnetId, one pool: launches take turns starting in each
  instanceType: string;        // MUST be arm64/Graviton — the AMI is arm64-only
  fallbackInstanceTypes: string[]; // tried in order once instanceType has no capacity in any subnet; arm64 too
  hostSecurityGroupId?: string; // optional: SG fronting the agent endpoint — box SG gets :3040 ingress here
  assumeRoleArn?: string;      // optional: cross-account provisioner role to assume for every AWS call
  managedTag: string;          // ManagedBy tag value the grant scopes on
  rootVolumeGb: number;
  gitTokenSecretArn?: string;  // optional: private-repo PAT, read at boot via SSM/SM
  ecrPull?: BoxEcrPullConfig;  // optional: pull-only ECR repositories for the box role (boxEcrPolicy.ts)
}

/**
 * Reads box config from the environment. Returns null when the feature is not
 * configured (local dev, or a deploy that hasn't surfaced the module outputs
 * into the secret yet) so callers can fall back to the manual-terraform path.
 */
export function getBoxConfig(env: NodeJS.ProcessEnv = process.env): BoxConfig | null {
  const region = env.AWS_REGION;
  const agentWsUrl = env.AGENT_WS_URL;
  const resourcePrefix = env.BOX_RESOURCE_PREFIX;
  const permissionsBoundaryArn = env.BOX_PERMISSIONS_BOUNDARY_ARN;
  const vpcId = env.BOX_VPC_ID;
  const subnetId = env.BOX_SUBNET_ID;

  if (!region || !agentWsUrl || !resourcePrefix || !permissionsBoundaryArn || !vpcId || !subnetId) {
    return null;
  }
  const instanceType = env.BOX_INSTANCE_TYPE ?? 't4g.medium';

  // The minimal flavor's disk default is the boxDiskSize module's concern
  // (minimalDefaultDiskGiB) — nothing here floors a launch by it anymore.
  const rootVolumeGb = parseInt(env.BOX_ROOT_VOLUME_GB ?? '120', 10);

  return {
    region,
    agentWsUrl,
    resourcePrefix,
    permissionsBoundaryArn,
    vpcId,
    subnetId,
    // Optional: only the EC2-hosted orchestrator has a host SG to open. A
    // containerised orchestrator reaches boxes' agents through its ingress or
    // an internal LB whose reachability is managed in terraform, not here.
    hostSecurityGroupId: env.HOST_SECURITY_GROUP_ID?.trim() || undefined,
    // Optional: cross-account role chaining for an orchestrator whose ambient
    // identity (e.g. an EKS pod identity) lives outside the box account.
    assumeRoleArn: env.BOX_PROVISIONER_ROLE_ARN?.trim() || undefined,
    instanceType,
    // Optional: a box launch otherwise depends on one AZ having one type free,
    // which is how the warm pool failed 2026-10-20..22 (m9g.2xlarge, us-east-2a).
    // No subnet is primary: launchCandidates rotates where each launch starts.
    fallbackSubnetIds: parseList(env.BOX_FALLBACK_SUBNET_IDS).filter(s => s !== subnetId),
    fallbackInstanceTypes: parseList(env.BOX_FALLBACK_INSTANCE_TYPES).filter(t => t !== instanceType),
    managedTag: env.BOX_MANAGED_TAG ?? 'termag-box',
    // A floor, not the final size: resolveRootDevice raises it to the AMI
    // snapshot's size when the image is bigger, so this never has to keep pace
    // with the bake.
    rootVolumeGb,
    gitTokenSecretArn: env.BOX_GIT_TOKEN_SECRET_ARN || undefined,
    ecrPull: parseBoxEcrPull(env),
  };
}

/** A comma-separated env list, trimmed, blanks and repeats dropped. */
function parseList(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(',').map(s => s.trim()).filter(Boolean))];
}

export function isBoxProvisioningConfigured(): boolean {
  return getBoxConfig() !== null;
}

/**
 * SDK client config for the box account. With BOX_PROVISIONER_ROLE_ARN set,
 * credentials come from sts:AssumeRole on that role (refreshed automatically by
 * the provider); otherwise the default chain (instance role, pod identity, env)
 * is used as-is. `region` may differ from cfg.region for boxes recorded in
 * another region.
 */
export function awsClientConfig(cfg: Pick<BoxConfig, 'region' | 'assumeRoleArn'>, region: string = cfg.region): {
  region: string;
  credentials?: ReturnType<typeof fromTemporaryCredentials>;
} {
  if (!cfg.assumeRoleArn) return { region };
  return {
    region,
    credentials: fromTemporaryCredentials({
      params: {
        RoleArn: cfg.assumeRoleArn,
        RoleSessionName: 'termag-box-provisioner',
        DurationSeconds: 3600,
      },
      clientConfig: { region },
    }),
  };
}

// ── Cloud-init (TS port of terraform/box/cloudinit.sh.tftpl) ─────────────────

export interface CloudInitVars {
  termagUrl: string;       // AGENT_WS_URL
  agentToken: string;      // raw tmag_ token (only sensitive value in user_data)
  gitUserEmail: string;
  gitUserName: string;
  remoteUnixUser: string;  // user's unix username; path_remap rewrites it to termag
  ownerAuthorizedKeys?: string[]; // validated key lines -> managed block in ~/.ssh/authorized_keys
  setupOff?: boolean;        // Instance.setupEnabled false (services/boxSetup.ts)
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
  // The rename's path fix-up is packer/scripts/rewrite-home-paths.sh, fed by
  // the index packer/scripts/index-home-paths.sh takes at bake time.
  const agentConfig = JSON.stringify({
    termag_url: v.termagUrl,
    token: v.agentToken,
  }, null, 2);
  // base64 so no key comment can break out of the shell literal
  const ownerKeys = v.ownerAuthorizedKeys ?? [];
  const managedKeysB64 = Buffer.from(managedBlock(ownerKeys), 'utf8').toString('base64');

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
# Move the directory ourselves and let usermod update only the passwd record.
# \`usermod -m\` does the same rename(2) and then walks the whole home, one stat
# per file, to fix ownership that does not change here (measured: 100,377
# newfstatat calls for 100,003 files). On a box that walk hits a root volume
# EBS restores lazily from the snapshot, and on the quick-start image it took
# 4 minutes (2026-09-25 box: user manager stopped 16:21:01, next step 16:25:04).
# mv is one rename(2). Ownership is untouched because the UID and GID stay the
# same; the baked-path fix-up is Steps 3+4. An owner literally named termag
# needs no rename at all.
if [ "$UNIX_USER" != termag ]; then
  mv /home/termag "/home/$UNIX_USER"
  usermod -l "$UNIX_USER" -d "/home/$UNIX_USER" termag
  groupmod -n "$UNIX_USER" termag
fi
USER_UID=$(id -u "$UNIX_USER")

# ── Steps 3+4: rewrite the baked /home/termag path (symlink targets + text files)
# The bake indexes every symlink and text file under the baked home that embeds
# /home/termag (packer/scripts/index-home-paths.sh) and installs the rewrite as
# /usr/local/sbin/termag-rewrite-home-paths; only the indexed entries are
# touched. Walking the home here instead cost 4.5 to 15.5 minutes, because a
# box's root volume is restored lazily from the snapshot and every first read
# is an S3 round trip -- and the orchestrator marks a box failed at 15. Guarded
# like every step before 5: nothing here may abort the boot before the agent
# is started.
echo "=== steps 3+4: rewriting baked /home/termag paths at $(date -Iseconds) ==="
if [ -x /usr/local/sbin/termag-rewrite-home-paths ]; then
  /usr/local/sbin/termag-rewrite-home-paths /home/termag "/home/$UNIX_USER" \\
    || echo "WARNING: path rewrite reported a problem (non-fatal)"
else
  echo "WARNING: /usr/local/sbin/termag-rewrite-home-paths is missing; this AMI predates the home-path index, so baked /home/termag paths were not rewritten"
fi

# ── Step 4b: make the renamed pyenv libs findable ────────────────────────
# The index only lists *text* files -- its \`grep -I\` deliberately skips binaries.
# But CPython built with --enable-shared records the bake-time library path in
# its ELF RUNPATH, and /home/termag/.pyenv/... no longer exists after the
# rename, so python3 cannot start at all:
#
#   libpython3.13.so.1.0: cannot open shared object file
#
# Anything shelling out to python3 fails with it, including the Claude Code
# Notification hook. Point the dynamic linker at the real location rather than
# rewriting RUNPATHs. Guarded like Steps 3-4: never abort the boot.
echo "=== step 4b: registering pyenv lib dirs with the dynamic linker ==="
{
  : > /etc/ld.so.conf.d/pyenv.conf
  for libdir in /home/"$UNIX_USER"/.pyenv/versions/*/lib; do
    [ -d "$libdir" ] || continue
    ls "$libdir"/libpython*.so* >/dev/null 2>&1 || continue
    echo "$libdir" >> /etc/ld.so.conf.d/pyenv.conf
  done
  ldconfig
} || echo "WARNING: step 4b failed; python3 may not start (non-fatal)"

# ── Step 4c: install the owner's registered SSH keys ─────────────────────
# Termag-account boxes are key-only sshd behind SSM, so without a key here
# there is no ssh/scp/rsync/ssh -L. Only the termag-managed block is replaced;
# the orchestrator keeps it in sync afterwards (services/sshKeySync.ts).
MANAGED_KEYS_B64='${managedKeysB64}'
if [ -n "$MANAGED_KEYS_B64" ]; then
  echo "=== step 4c: installing ${ownerKeys.length} owner SSH key(s) ==="
  SSH_DIR="/home/$UNIX_USER/.ssh"
  AK="$SSH_DIR/authorized_keys"
  AK_TMP=""
  # Built beside the file and renamed over it, so a failure never leaves a
  # partial or root-owned file that the agent (running as the owner) can't rewrite.
  install -d -m 700 -o "$UNIX_USER" -g "$UNIX_USER" "$SSH_DIR" \\
    && AK_TMP="$(mktemp "$SSH_DIR/.authorized_keys.XXXXXX")" \\
    && { [ ! -e "$AK" ] || sed '/^${MANAGED_BEGIN}$/,/^${MANAGED_END}$/d' "$AK"; } > "$AK_TMP" \\
    && { [ ! -s "$AK_TMP" ] || [ -z "$(tail -c1 "$AK_TMP")" ] || echo >> "$AK_TMP"; } \\
    && printf '%s' "$MANAGED_KEYS_B64" | base64 -d >> "$AK_TMP" \\
    && chmod 600 "$AK_TMP" \\
    && chown "$UNIX_USER:$UNIX_USER" "$AK_TMP" \\
    && mv -f "$AK_TMP" "$AK" \\
    || echo "WARNING: step 4c failed; the orchestrator retries when the agent connects (non-fatal)"
  [ -z "$AK_TMP" ] || rm -f "$AK_TMP"
else
  echo "=== step 4c: owner has no registered SSH keys, skipping ==="
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
${v.setupOff ? setupOffStep() : ''}
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

/**
 * The first-boot step of a box with termag setup off. The marker must
 * exist before Step 7: linger starts the user manager, whose
 * termag-reconcile.service is the first thing to read it. The image was baked
 * as a full box, so `termag-reconcile --strip` then removes the skills and
 * agent config the bake installed, where they are still termag's unedited
 * copies. Guarded like Steps 3-4c: an image whose reconcile predates --strip
 * keeps them, and the box must still come up.
 */
function setupOffStep(): string {
  return `
# ── Step 6b: termag setup off: the marker, then the baked config removed ──
echo "=== step 6b: termag setup off ==="
sudo -u "$UNIX_USER" -H sh -c 'mkdir -p "$HOME/${BOX_SETUP_DIR}" && printf "off\\n" > "$HOME/${BOX_SETUP_FILE}"' \\
  || echo "WARNING: could not write the termag setup marker (non-fatal)"
sudo -u "$UNIX_USER" -H bash "/home/$UNIX_USER/src/termag/deploy/termag-reconcile" --strip \\
  || echo "WARNING: termag-reconcile --strip reported a problem (non-fatal)"
`;
}

// POSIX single-quote escaping for embedding an arbitrary string in shell.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface WarmCloudInitVars {
  termagUrl: string;      // AGENT_WS_URL
  agentToken: string;     // raw tmag_ token, with no owner attached to it yet
  poolSpecHash: string;   // the spec this box was launched from
  /** An environment pool box: the environment it is prepared for. Unset: the warm pool. */
  environmentId?: string;
}

/**
 * Build a warm-pool box's first-boot cloud-init.
 *
 * Deliberately a separate script from buildCloudInit rather than a flag on it.
 * The cold path's first four steps stop every process the baked `termag` user
 * owns, rename that user and its group, move the home directory and sweep
 * /home/termag out of six toolchain directories. A pool box keeps the baked
 * user as it is, so none of that appears here, and that absence is the whole
 * reason a claim can finish in one round trip rather than tens of seconds.
 *
 * There is no git identity here either. The box has no owner while it is in
 * the pool, so it is given one at claim time through the box-claim RPC.
 */
export function buildWarmCloudInit(v: WarmCloudInitVars): string {
  const agentConfig = JSON.stringify({
    termag_url: v.termagUrl,
    token: v.agentToken,
    // The agent reads this to decide whether to announce itself as a pool box
    // and to poll the on-warm status file.
    warm: true,
  }, null, 2);

  const poolMarker = JSON.stringify({
    schema: 1, poolSpecHash: v.poolSpecHash,
    // An environment pool's marker: the agent's hello says so, and the
    // orchestrator sends environment-prepare rather than on-warm-start.
    ...(v.environmentId !== undefined ? { pool: 'environment', environment: v.environmentId } : {}),
  }, null, 2);

  return `#!/bin/bash
# termag warm-pool box first-boot wiring (generated by boxProvisioner.ts).
set -euo pipefail

exec > >(tee /var/log/termag-cloudinit.log) 2>&1
echo "=== termag warm box cloud-init starting at $(date -Iseconds) ==="

BOX_HOME=/home/termag
BOX_UID=$(id -u termag)

# 700 because the on-warm credential lands in here later, and termag-hook-run
# expects to find the directory already tightened.
install -d -o termag -g termag -m 700 "$BOX_HOME/.termag"
umask 077

# ── Pool marker ──────────────────────────────────────────────────────────
# Which pool spec this box booted from, for anyone debugging a rollover from
# the box itself. Instance.poolSpecHash is the orchestrator's copy.
cat > /tmp/pool.json <<'JSON'
${poolMarker}
JSON
install -o termag -g termag -m 600 /tmp/pool.json "$BOX_HOME/.termag/pool.json"
rm -f /tmp/pool.json

# ── Agent bearer token ───────────────────────────────────────────────────
# Carries zero AWS authority: the box's blast radius is governed by the
# instance role and its permissions boundary, a credential this cannot touch.
cat > /tmp/agent.config.json <<'JSON'
${agentConfig}
JSON
install -o termag -g termag -m 600 /tmp/agent.config.json "$BOX_HOME/src/termag/agent/agent.config.json"
rm -f /tmp/agent.config.json

# ── Start the agent ──────────────────────────────────────────────────────
# The bake enables linger already. Repeated because it is idempotent and the
# agent does not survive a logout without it.
loginctl enable-linger termag
sleep 2

sudo -u termag XDG_RUNTIME_DIR=/run/user/$BOX_UID systemctl --user daemon-reload
sudo -u termag XDG_RUNTIME_DIR=/run/user/$BOX_UID systemctl --user enable --now termag-agent.service

# Nothing enables the on-warm unit here. The backend starts it over the agent
# socket once the agent is connected, so the GitHub token the scripts will need
# is handed to a connected agent and never rides in user_data.
sleep 2
sudo -u termag XDG_RUNTIME_DIR=/run/user/$BOX_UID systemctl --user is-active termag-agent.service || true

echo "=== termag warm box cloud-init complete at $(date -Iseconds) ==="
`;
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
  /** The owner's `box-image` flag (boxImage.boxImageSelectionFor); required so no caller launches a user's box without deciding. */
  image: BoxImageSelection;
  /** A type of the caller's own in place of BOX_INSTANCE_TYPE and its fallbacks. Unset: the configured ones. */
  instanceTypes?: InstanceTypeChoice;
  /** The disk the box was asked for (services/boxDiskSize.ts). Unset: the flavor's default, as a pool box gets. */
  diskGiB?: number | null;
  /** Which flavor's image (services/boxFlavor.ts); the relaunch path always says 'full'. */
  flavor: BoxFlavor;
}
/** An instance type to launch, and the ones to try in order when EC2 has no capacity for it. All arm64. */
export interface InstanceTypeChoice {
  type: string;
  fallbacks: string[];
}

/** The config a launch walks: `choice` in place of the configured types, its fallbacks without the primary or repeats. */
export function withInstanceTypes(cfg: BoxConfig, choice: InstanceTypeChoice | undefined): BoxConfig {
  if (!choice) return cfg;
  const instanceType = choice.type.trim();
  const fallbacks = [...new Set(choice.fallbacks.map(t => t.trim()).filter(t => t && t !== instanceType))];
  return { ...cfg, instanceType, fallbackInstanceTypes: fallbacks };
}

const NOT_CONFIGURED = 'box provisioning not configured (missing AWS_REGION / BOX_* env)';

/**
 * Launch the box. Best-effort: marks the Instance `failed` (with
 * provisioningError) on any error. Never throws to the caller — the route
 * fires this un-awaited.
 */
export async function provisionBox(args: ProvisionArgs): Promise<void> {
  const cfg = getBoxConfig();
  if (!cfg) {
    await markFailed(args.instance.id, NOT_CONFIGURED);
    return;
  }

  let ownerAuthorizedKeys: string[] = [];
  if (args.instance.userId) {
    try {
      ownerAuthorizedKeys = await ownerAuthorizedKeyLines(args.instance.userId);
    } catch (err) {
      // Not worth failing the launch: the agent's first connect syncs them.
      console.error(`[BOX] ${args.boxName}: could not load owner SSH keys:`, errMsg(err));
    }
  }

  const userData = buildCloudInit({
    termagUrl: cfg.agentWsUrl,
    agentToken: args.token,
    gitUserEmail: args.gitUserEmail,
    gitUserName: args.gitUserName,
    remoteUnixUser: args.remoteUnixUser,
    ownerAuthorizedKeys,
    setupOff: isSetupOff(args.instance),
  });

  const launched = await launchBox(withInstanceTypes(cfg, args.instanceTypes), {
    instanceId: args.instance.id,
    boxName: args.boxName,
    userData,
    image: args.image,
    diskGiB: args.diskGiB,
    flavor: args.flavor,
    extraTags: [
      { Key: 'Owner', Value: args.owner },
      { Key: 'BoxName', Value: args.boxName },
    ],
  });
  if (launched) {
    console.log(`[BOX] Provisioned ${args.boxName} → ${launched.ec2InstanceId} (sg=${launched.securityGroupId}, role=${launched.iamRoleName})`);
  }
}

export interface ProvisionPoolArgs {
  instance: Instance;
  token: string;          // raw agent bearer token, bound to the box and to no user
  poolSpecHash: string;   // already recorded on the Instance row by the reconciler
  size: BoxSize | null;   // the pool's box-default-size, also in poolSpecHash and on the row; null: BOX_INSTANCE_TYPE
}

/**
 * Launch an ownerless pool box. Same AWS sequence as provisionBox with the
 * warm cloud-init and a Pool=warm tag, which is what separates pool spend from
 * owned-box spend in cost allocation.
 *
 * Returns whether the launch reached RunInstances. A failure is already
 * recorded on the row and counts toward the reconciler's breaker.
 */
export async function provisionPoolBox(args: ProvisionPoolArgs): Promise<boolean> {
  const cfg = getBoxConfig();
  if (!cfg) {
    await markFailed(args.instance.id, NOT_CONFIGURED);
    return false;
  }

  const userData = buildWarmCloudInit({
    termagUrl: cfg.agentWsUrl,
    agentToken: args.token,
    poolSpecHash: args.poolSpecHash,
  });

  const launched = await launchBox(withInstanceTypes(cfg, instanceTypesForSize(args.size)), {
    instanceId: args.instance.id,
    boxName: args.instance.name,
    userData,
    // Always the published image: the pool spec hash (warmPool.currentPoolSpecHash) is built from it.
    image: PUBLISHED_IMAGE,
    // A pool box is always the full flavor — BOX_FLAVORS.minimal.warmPoolEligible is false, nowhere claims one.
    flavor: 'full',
    extraTags: [
      { Key: 'BoxName', Value: args.instance.name },
      { Key: 'Pool', Value: 'warm' },
    ],
  });
  if (launched) {
    console.log(`[POOL] booted ${args.instance.id} (${args.instance.name}) ec2=${launched.ec2InstanceId} sg=${launched.securityGroupId} role=${launched.iamRoleName}`);
  }
  return launched !== null;
}

export interface ProvisionEnvPoolArgs {
  instance: Instance;
  token: string;          // raw agent bearer token, bound to the box and to no user
  poolSpecHash: string;   // the warm pool spec (image, type, cloud-init shape) for the size
  environmentId: string;
  size: BoxSize | null;
  diskGiB: number | null;
  subnetId: string | null;
}

/**
 * Launch an ownerless environment-pool box:
 * the warm cloud-init with the pool marker naming the
 * environment, the published image at the environment's size and disk, in the
 * subnet the planner picked for its zone balance, tagged Pool=environment.
 * Its hello is answered with environment-prepare (services/envPool.ts).
 */
export async function provisionEnvPoolBox(args: ProvisionEnvPoolArgs): Promise<boolean> {
  const cfg = getBoxConfig();
  if (!cfg) {
    await markFailed(args.instance.id, NOT_CONFIGURED, 'env-failed');
    return false;
  }
  const userData = buildWarmCloudInit({
    termagUrl: cfg.agentWsUrl, agentToken: args.token, poolSpecHash: args.poolSpecHash, environmentId: args.environmentId,
  });
  const launched = await launchBox(withInstanceTypes(cfg, instanceTypesForSize(args.size)), {
    instanceId: args.instance.id,
    boxName: args.instance.name,
    userData,
    image: PUBLISHED_IMAGE,
    flavor: 'full',
    diskGiB: args.diskGiB,
    startSubnetId: args.subnetId,
    extraTags: [
      { Key: 'BoxName', Value: args.instance.name },
      { Key: 'Pool', Value: 'environment' },
    ],
  }, 'env-failed');
  if (launched) {
    console.log(`[ENV-POOL] booted ${args.instance.id} (${args.instance.name}) ec2=${launched.ec2InstanceId} for environment ${args.environmentId}`);
  } else {
    await cleanUpFailedPoolLaunch(args.instance.id);
  }
  return launched !== null;
}

/**
 * A failed pool launch's row is env-failed at once, kept for its pool's page, and nobody retries it: what the launch
 * had created (its security group, IAM role, any instance) is torn down now, as a failed prepare's box is
 * (services/envPool.ts failPrepare). A row the launch didn't fail (quarantined, whose containment runs on its own, or
 * gone) is left alone.
 */
export async function cleanUpFailedPoolLaunch(
  instanceId: string,
  deps: { find(id: string): Promise<Instance | null>; terminate(row: Instance): Promise<boolean> } = {
    find: id => prisma.instance.findUnique({ where: { id } }),
    terminate: terminateBox,
  },
): Promise<void> {
  const row = await deps.find(instanceId).catch(() => null);
  if (row?.status !== 'env-failed') return;
  await deps.terminate(row).catch(err => console.error(`[ENV-POOL] ${instanceId}: tearing down the failed launch failed:`, errMsg(err)));
}

interface LaunchBoxArgs {
  instanceId: string;
  boxName: string;   // human-readable label for the SG description and the logs
  userData: string;
  image: BoxImageSelection;
  diskGiB?: number | null;  // the disk asked for (amiWithDisk); unset: the AMI's discovered size
  extraTags: Tag[];  // appended after Name/App/ManagedBy on every resource
  /** Which flavor the launch rides (services/boxFlavor.ts); a pool launch never says 'minimal'. */
  flavor: BoxFlavor;
  /** The subnet to try first (an environment pool's zone balance); unset: the rotation. */
  startSubnetId?: string | null;
}

/** The AWS resource handles a successful launch leaves behind. */
interface LaunchedBox {
  ec2InstanceId: string;
  securityGroupId: string;
  iamRoleName: string;
}

/**
 * The AWS half of a box launch, shared by the cold path and the warm pool: SG,
 * host ingress, per-box IAM identity, RunInstances, private DNS. Only the
 * cloud-init and a couple of tags differ between the two, which is why they
 * share this rather than a copy.
 *
 * Returns null when the launch failed, having already recorded the error on
 * the Instance row. Neither caller throws, because both are fired un-awaited.
 */
async function launchBox(cfg: BoxConfig, a: LaunchBoxArgs, failedStatus: 'failed' | 'env-failed' = 'failed'): Promise<LaunchedBox | null> {
  launchesInFlight.add(a.instanceId);
  try {
    return await runLaunch(cfg, a, failedStatus);
  } finally {
    launchesInFlight.delete(a.instanceId);
  }
}

/**
 * Instance ids whose launchBox is still running in this process. The stuck
 * sweep can mark one `failed` while it waits on AWS; sweepFailedLaunches must
 * not delete its SG and role from under it. A restart ends every launch, so
 * this process's set is the whole truth (the orchestrator is one replica).
 */
const launchesInFlight = new Set<string>();

async function runLaunch(cfg: BoxConfig, a: LaunchBoxArgs, failedStatus: 'failed' | 'env-failed'): Promise<LaunchedBox | null> {
  // Globally-unique physical name (box names are only unique per user). Still
  // matches the grant's `<prefix>-*` resource condition. Human-readable detail
  // lives in the Owner/BoxName tags.
  const name = `${cfg.resourcePrefix}-${a.instanceId}`;
  const ec2 = new EC2Client(awsClientConfig(cfg));
  const iam = new IAMClient(awsClientConfig(cfg));

  const tags: Tag[] = [
    { Key: 'Name', Value: name },
    { Key: 'App', Value: 'termag' },
    { Key: 'ManagedBy', Value: cfg.managedTag },
    ...a.extraTags,
  ];

  // Every handle is written the moment its resource exists, so a launch cut
  // short (a restart, an SDK error) leaves a row terminateBox can clean up
  // from. Clearing cleanedUpAt makes the sweep tear down again when the user
  // terminated the box while this launch was still creating resources.
  const record = (data: Prisma.InstanceUpdateInput) =>
    prisma.instance.update({ where: { id: a.instanceId }, data: { ...data, cleanedUpAt: null } });

  try {
    // 1. The box AMI, per the flavor's spec (services/boxFlavor.ts) — 'full'
    //    is the published one unless the owner's box-image flag or a channel
    //    names another; 'minimal' owns the lean Component=box-min discovery
    //    and never reads the flag — plus the root-device shape to launch it
    //    with. The root is the disk asked for, never under the image's
    //    snapshot; the row records what the box gets, hibernation's RAM aside.
    //    A minimal caller resolved diskGiB with BOX_MINIMAL_ROOT_VOLUME_GB's
    //    default in the mix (routes/instances.ts).
    const image = await flavorSpec(a.flavor).resolveImage({ ec2, cfg, selection: a.image });
    const ami = amiWithDisk(image.ami, a.diskGiB);

    // 2. Per-box egress-only SG (AWS adds the default allow-all egress rule).
    const sg = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: name,
      // SG descriptions must be ASCII-only — no em-dash here.
      Description: `termag box ${a.boxName} - outbound only, no inbound`,
      VpcId: cfg.vpcId,
      TagSpecifications: [{ ResourceType: 'security-group', Tags: [...tags, { Key: 'Component', Value: 'box-sg' }] }],
    }));
    const securityGroupId = sg.GroupId!;
    await record({ region: cfg.region, securityGroupId, imageId: ami.imageId, imageSource: image.source, diskGiB: ami.rootVolumeGb });

    // 3. Let the box reach the orchestrator: :3040 ingress on the host SG from
    //    the box SG (grant's Ec2BoxIngressToHost). Only the EC2-hosted
    //    orchestrator has such an SG; off-host deployments expose the agent
    //    endpoint through an ingress/LB whose reachability terraform owns.
    if (cfg.hostSecurityGroupId) {
      await authorizeHostIngress(ec2, cfg.hostSecurityGroupId, securityGroupId, a.boxName);
    } else {
      console.log(`[BOX] HOST_SECURITY_GROUP_ID unset; relying on the agent endpoint's own ingress rules for ${a.boxName}`);
    }

    // 4. Per-box IAM identity (role WITH the permissions boundary — denied
    //    otherwise) → SSM core → optional git-token read → optional ECR pull → instance profile.
    const iamRoleName = await createBoxRole(iam, name, cfg, tags, {
      onRoleCreated: () => record({ iamRoleName: name }),
      onProfileCreated: () => record({ iamInstanceProfileName: name }),
    });

    // 5. Launch, hibernation-capable when the AMI and the type allow it.
    //    EC2 only takes HibernationOptions here, never later. A capacity
    //    refusal moves on to the next subnet, then the next type.
    // An admin may have quarantined the box while its SG and role were being
    // made; never boot an instance for it. The SG and role are left for the
    // admin's terminate, which tears them down from the handles recorded above.
    if (await isQuarantinedNow(a.instanceId)) {
      console.warn(`[BOX] ${a.boxName}: quarantined during its launch; not starting an instance`);
      return null;
    }
    //    The root volume's initialization rate (box-volume-initialization-rate)
    //    is read here, per launch; off, EBS loads each block on first read.
    const volumeInitRate = await boxVolumeInitRate();
    //    So are its throughput and IOPS above gp3's baseline
    //    (box-root-volume-performance); off, 125 MiB/s and 3,000 IOPS.
    const volumePerformance = await boxVolumePerformance();
    //    A trace of its own: the warm pool and box creation start launches
    //    without awaiting them, so there is often no parent span, and a
    //    request's would have ended long before the instance is up.
    const launched = await rootSpan('termag.box.launch', { 'termag.box.flavor': a.flavor }, async (span) => {
      const l = await runInstanceWithFallback(ec2, a.boxName, true,
        { ami, name, securityGroupId, iamRoleName, userData: a.userData, cfg, tags, volumeInitRate, volumePerformance }, a.startSubnetId);
      const perf = effectiveVolumePerformance(l.volumePerformance);
      span.setAttributes({
        'termag.box.instance_type': l.instanceType,
        'termag.box.subnet_id': l.subnetId,
        'termag.box.availability_zone': l.availabilityZone ?? 'unknown',
        // 0: no rate on the root volume (flag off, or EBS refused it).
        'termag.box.volume_init_rate': l.volumeInitRate ?? 0,
        // What the root volume got: gp3's 125 MiB/s and 3,000 IOPS when the
        // flag is off, EBS refused them, or they fit only the baseline.
        'termag.box.volume_throughput': perf.throughput,
        'termag.box.volume_iops': perf.iops,
      });
      return l;
    });
    const perf = effectiveVolumePerformance(launched.volumePerformance);
    console.log(`[BOX] ${a.boxName}: launched ${launched.instanceId} (${launched.instanceType}) in ${launched.availabilityZone ?? launched.subnetId}, root volume init rate ${launched.volumeInitRate ? `${launched.volumeInitRate} MiB/s` : 'off'}, ${perf.throughput} MiB/s and ${perf.iops} IOPS${launched.volumePerformance ? '' : ' (gp3 baseline)'}`);
    const ec2InstanceId = launched.instanceId;
    // Where it is, too: a stopped box can't change zone, so an environment pool's claim
    // refused for capacity in one zone takes a box in another.
    await record({
      ec2InstanceId, hibernationConfigured: launched.hibernationConfigured, instanceType: launched.instanceType,
      subnetId: launched.subnetId, availabilityZone: launched.availabilityZone,
    });
    // Quarantined while RunInstances was in flight: that run had no instance
    // to contain, so its AWS steps are run again now there is one.
    if (await isQuarantinedNow(a.instanceId)) {
      console.warn(`[BOX] ${a.boxName}: quarantined while ${ec2InstanceId} was launching; containing it`);
      const { resumeQuarantineAfterLaunch } = await import('./boxQuarantine');
      void resumeQuarantineAfterLaunch(a.instanceId)
        .catch(err => console.error(`[QUARANTINE] ${a.boxName}: containing ${ec2InstanceId} after its launch failed; the provisioning sweep retries:`, errMsg(err)));
      return null;
    }

    // 6. Private DNS, diagnostic only. Status stays `provisioning` (or
    //    `warming` for a pool box) until the agent dials in. Never fails the
    //    launch: the box is running and its handles are already recorded.
    const hostname = await describePrivateDns(ec2, ec2InstanceId);
    if (hostname) {
      await record({ hostname }).catch(e => console.error(`[BOX] could not record hostname for ${a.boxName}:`, errMsg(e)));
    }

    return { ec2InstanceId, securityGroupId, iamRoleName };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[BOX] Provisioning failed for ${a.boxName}:`, msg);
    await markFailed(a.instanceId, msg, failedStatus);
    return null;
  }
}

/** What launching an AMI needs to know about it: which image, and how to size its root volume. */
export interface BoxAmi {
  imageId: string;
  rootDeviceName: string;
  rootVolumeGb: number;
  /** The image's own root snapshot size: no root volume may be smaller (amiWithDisk). Absent: rootVolumeGb is the floor. */
  imageGb?: number;
  /** Tagged Hibernation=supported by the bake (packer/scripts/enable-hibernation.sh). */
  hibernationSupported: boolean;
  /**
   * The termag commit the image was baked from (its TermagSha tag, set by
   * publish-ami.yml). What a current box runs, for services/boxUpdate; null
   * on an image baked by hand without the tag.
   */
  termagSha: string | null;
  /** The image's CreationDate (ISO 8601): when a current box's code was baked. */
  createdAt: string | null;
}

/**
 * The AMI to launch with the disk a box was asked for (services/boxDiskSize.ts)
 * as its root volume, raised to the image's snapshot when that is bigger, as
 * EC2 refuses a smaller one: 50 GB on the 120 GB image is 120. With none asked
 * for, the AMI as discovered (BOX_ROOT_VOLUME_GB, else the snapshot).
 * Hibernation's RAM goes on top of this (planHibernation).
 */
export function amiWithDisk<A extends Pick<BoxAmi, 'rootVolumeGb' | 'imageGb'>>(ami: A, diskGiB: number | null | undefined): A {
  if (diskGiB == null) return ami;
  return { ...ami, rootVolumeGb: Math.max(diskGiB, ami.imageGb ?? ami.rootVolumeGb) };
}

/** The AMI tag naming the commit it was baked from (publish-ami.yml). */
export const AMI_TERMAG_SHA_TAG = 'TermagSha';

export function amiTermagSha(image: { Tags?: { Key?: string; Value?: string }[] }): string | null {
  const value = (image.Tags ?? []).find(t => t.Key === AMI_TERMAG_SHA_TAG)?.Value?.trim().toLowerCase();
  return value && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

/** The AMI tag the bake sets once hibinit-agent and nokaslr are in the image. */
export const AMI_HIBERNATION_TAG = { Key: 'Hibernation', Value: 'supported' } as const;

export function amiSupportsHibernation(image: { Tags?: { Key?: string; Value?: string }[] }): boolean {
  return (image.Tags ?? []).some(t => t.Key === AMI_HIBERNATION_TAG.Key && t.Value === AMI_HIBERNATION_TAG.Value);
}

/** What DescribeInstanceTypes says about the configured type, as far as hibernation goes. */
export interface InstanceTypeHibernationInfo {
  hibernationSupported: boolean;
  memoryMiB: number;
}

export interface HibernationPlan {
  configured: boolean;
  /** The root volume to launch with: the AMI's size, plus room for a RAM-sized swap file when configured. */
  rootVolumeGb: number;
  /** Why hibernation is off; null when it is on or simply not enabled. */
  reason: string | null;
}

/**
 * Whether to launch a box with HibernationOptions, and how big its root has to
 * be. hibinit-agent puts the RAM image in a swap file on the root volume and
 * EC2 requires the root to hold it, so the volume grows by the RAM size
 * rather than taking it out of the disk the box already uses.
 */
export function planHibernation(
  enabled: boolean,
  ami: Pick<BoxAmi, 'rootVolumeGb' | 'hibernationSupported'>,
  type: InstanceTypeHibernationInfo | null,
): HibernationPlan {
  const off = (reason: string | null): HibernationPlan => ({ configured: false, rootVolumeGb: ami.rootVolumeGb, reason });
  if (!enabled) return off(null);
  if (!ami.hibernationSupported) return off(`AMI is not tagged ${AMI_HIBERNATION_TAG.Key}=${AMI_HIBERNATION_TAG.Value}`);
  if (!type) return off('could not describe the instance type');
  if (!type.hibernationSupported) return off('instance type does not support hibernation');
  if (!(type.memoryMiB > 0)) return off('instance type reports no memory size');
  return { configured: true, rootVolumeGb: ami.rootVolumeGb + Math.ceil(type.memoryMiB / 1024), reason: null };
}

async function planBoxHibernation(ec2: EC2Client, instanceType: string, ami: BoxAmi, enabled: boolean): Promise<HibernationPlan> {
  if (!enabled || !ami.hibernationSupported) return planHibernation(enabled, ami, null);
  let type: InstanceTypeHibernationInfo | null = null;
  try {
    const res = await ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: [instanceType as any] }));
    const info = res.InstanceTypes?.[0];
    if (info) type = { hibernationSupported: !!info.HibernationSupported, memoryMiB: info.MemoryInfo?.SizeInMiB ?? 0 };
  } catch (err) {
    console.warn(`[BOX] DescribeInstanceTypes ${instanceType} failed:`, errMsg(err));
  }
  return planHibernation(true, ami, type);
}

// Every termag box AMI has used /dev/sda1. Only a fallback for an AMI that
// somehow reports no RootDeviceName — the real value comes from the image.
const DEFAULT_ROOT_DEVICE_NAME = '/dev/sda1';

/** The subset of EC2's Image that sizing the root volume actually reads. */
interface AmiRootShape {
  RootDeviceName?: string;
  BlockDeviceMappings?: { DeviceName?: string; Ebs?: { VolumeSize?: number } }[];
}

/**
 * The root block-device mapping to launch an AMI with: the image's own root
 * device, sized to at least its snapshot.
 *
 * EC2 rejects RunInstances outright when the requested size is under the
 * snapshot's ("Volume of size 50GB is smaller than snapshot 'snap-...', expect
 * size >= 120GB"), which is exactly how box provisioning broke on 2026-09-16:
 * the AMI grew 50 → 120GB while the running orchestrator still asked for 50.
 * Taking the floor from the image means no orchestrator deploy has to keep pace
 * with the bake, so AMI growth can never break provisioning again.
 *
 * Naming the device from the image matters as much as the size: a mapping for a
 * device the AMI does not boot from is not a resize, it is an *extra* volume,
 * and the box would come up on the snapshot's size with a stray disk attached.
 */
export function resolveRootDevice(
  image: AmiRootShape,
  configuredGb: number,
): { deviceName: string; volumeGb: number } {
  const deviceName = image.RootDeviceName?.trim() || DEFAULT_ROOT_DEVICE_NAME;
  const amiGb = image.BlockDeviceMappings?.find(m => m.DeviceName === deviceName)?.Ebs?.VolumeSize ?? 0;
  // A non-numeric BOX_ROOT_VOLUME_GB must not poison the result: fall back to
  // the AMI's own size rather than sending EC2 a NaN.
  const configured = Number.isFinite(configuredGb) ? configuredGb : 0;
  return { deviceName, volumeGb: Math.max(configured, amiGb) };
}

/**
 * Exported for the warm pool: the pool spec hash is built from the AMI id, so
 * the reconciler needs the same discovery the launch uses rather than a second
 * copy of the tag filter that could drift from it.
 *
 * `component` distinguishes the standard bake (Component=box) from the lean
 * one (Component=box-min) — the anonymous minimal flavor's image. Callers
 * that reach for the minimal component go through resolveMinimalBoxImage;
 * everything else uses the default. There is no discovery floor anymore:
 * sizing moved to the launch (amiWithDisk), against the disk chosen for the
 * box (services/boxDiskSize.ts) and the image's own snapshot (imageGb).
 */
export async function discoverLatestAmi(
  ec2: EC2Client,
  cfg: BoxConfig,
  component: 'box' | 'box-min' = 'box',
): Promise<BoxAmi> {
  const res = await ec2.send(new DescribeImagesCommand({
    Filters: [
      { Name: 'tag:App', Values: ['termag'] },
      { Name: 'tag:Component', Values: [component] },
      { Name: 'state', Values: ['available'] },
    ],
    Owners: ['self'],
  }));
  const images = (res.Images ?? []).filter(i => i.CreationDate);
  if (images.length === 0) {
    throw new Error(`No box AMI found (tag App=termag, Component=${component}). Run \`packer build\` first.`);
  }
  images.sort((a, b) => (b.CreationDate! < a.CreationDate! ? -1 : 1));
  const ami = toBoxAmi(images[0], cfg);
  // What a create checks a disk asked for against before the launch (services/boxImageFloor.ts).
  recordImageFloor(component, ami.imageGb ?? ami.rootVolumeGb);
  return ami;
}

function toBoxAmi(image: Image, cfg: Pick<BoxConfig, 'rootVolumeGb'>): BoxAmi {
  const { deviceName, volumeGb } = resolveRootDevice(image, cfg.rootVolumeGb);
  if (volumeGb > cfg.rootVolumeGb) {
    console.log(`[BOX] AMI ${image.ImageId} needs ${volumeGb}GB; raising the root volume above the configured ${cfg.rootVolumeGb}GB`);
  }
  return {
    imageId: image.ImageId!,
    rootDeviceName: deviceName,
    rootVolumeGb: volumeGb,
    imageGb: resolveRootDevice(image, 0).volumeGb || undefined,
    hibernationSupported: amiSupportsHibernation(image),
    termagSha: amiTermagSha(image),
    createdAt: image.CreationDate ?? null,
  };
}

/** The image a launch uses, and how it was chosen. */
export interface ResolvedBoxImage {
  ami: BoxAmi;
  /** Instance.imageSource: boxImage.boxImageSource, or fallbackImageSource when the asked-for image was unusable. */
  source: string;
  /** True when the box-image flag's image is the one launched (not the published image, not a fallback). */
  selected: boolean;
}

/**
 * The image for a launch. The published selection is discoverLatestAmi; a
 * pin or a channel is looked up among self-owned images and must be an
 * available termag box image (boxImage.pickSelectedImage). When it is not,
 * or the lookup fails, the launch takes the published image with a warning
 * rather than failing: a bad flag value must not cost a user their box.
 * Only the published lookup's failure propagates, as it always has.
 */
export async function resolveBoxImage(ec2: EC2Client, cfg: BoxConfig, selection: BoxImageSelection): Promise<ResolvedBoxImage> {
  if (selection.kind === 'published') {
    return { ami: await discoverLatestAmi(ec2, cfg), source: boxImageSource(selection), selected: false };
  }
  let reason: string;
  try {
    const res = await ec2.send(new DescribeImagesCommand(selection.kind === 'pinned'
      ? { ImageIds: [selection.amiId], Owners: ['self'] }
      : {
          Filters: [
            { Name: 'tag:App', Values: ['termag'] },
            { Name: `tag:${AMI_CHANNEL_TAG}`, Values: [selection.channel] },
            { Name: 'state', Values: ['available'] },
          ],
          Owners: ['self'],
        }));
    const picked = pickSelectedImage(res.Images ?? [], selection);
    if ('image' in picked) {
      return { ami: toBoxAmi(picked.image, cfg), source: boxImageSource(selection), selected: true };
    }
    reason = picked.reason;
  } catch (err) {
    reason = `DescribeImages failed: ${errMsg(err)}`;
  }
  console.warn(`[BOX] box-image ${selectionKey(selection)} unusable (${reason}); launching from the published box image`);
  return { ami: await discoverLatestAmi(ec2, cfg), source: fallbackImageSource(selection), selected: false };
}

/**
 * The minimal flavor's image: the newest Component=box-min. This never falls
 * back to the published image the way a bad box-image flag value does: the
 * owner asked for a minimal box, and silently handing them the full bake is
 * the opposite of the ask — a missing minimal image fails the launch loudly
 * on the row.
 *
 * Sizing lives with the launch: the disk chosen for the box
 * (services/boxDiskSize.ts, whose fallback default for this flavor is
 * BOX_MINIMAL_ROOT_VOLUME_GB — see routes/instances.ts) clamps to the image's
 * own snapshot size through amiWithDisk. A lean image on a 120GB disk is
 * 100GB of nothing; that default is what keeps one from happening.
 */
export async function resolveMinimalBoxImage(ec2: EC2Client, cfg: BoxConfig): Promise<ResolvedBoxImage> {
  return {
    ami: await discoverLatestAmi(ec2, cfg, 'box-min'),
    // Not one of boxImage.boxImageSource's values; the box list renders it
    // via the same unknown-source branch that shows `pinned`/`channel`.
    source: 'minimal',
    selected: false,
  };
}

async function authorizeHostIngress(ec2: EC2Client, hostSgId: string, boxSgId: string, boxName: string): Promise<void> {
  await ec2.send(new AuthorizeSecurityGroupIngressCommand({
    GroupId: hostSgId,
    IpPermissions: [{
      IpProtocol: 'tcp',
      FromPort: 3040,
      ToPort: 3040,
      UserIdGroupPairs: [{ GroupId: boxSgId, Description: `termag box ${boxName}` }],
    }],
  }));
}

async function createBoxRole(
  iam: IAMClient,
  name: string,
  cfg: BoxConfig,
  tags: Tag[],
  recorded: { onRoleCreated: () => Promise<unknown>; onProfileCreated: () => Promise<unknown> },
): Promise<string> {
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
  await recorded.onRoleCreated();

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

  if (cfg.ecrPull) {
    await iam.send(new PutRolePolicyCommand({
      RoleName: name,
      PolicyName: BOX_ECR_PULL_INLINE_POLICY,
      PolicyDocument: boxEcrPullPolicyDocument(cfg.ecrPull),
    }));
  }

  await iam.send(new CreateInstanceProfileCommand({ InstanceProfileName: name }));
  await recorded.onProfileCreated();
  await iam.send(new AddRoleToInstanceProfileCommand({ InstanceProfileName: name, RoleName: name }));
  return name;
}

interface RunArgs {
  ami: BoxAmi;
  name: string;
  securityGroupId: string;
  iamRoleName: string;
  userData: string;
  cfg: BoxConfig;
  tags: Tag[];
  hibernation: HibernationPlan;
  instanceType: string;
  subnetId: string;
  /** The root volume's VolumeInitializationRate in MiB/s (services/boxVolumeInitRate.ts); unset: none. */
  volumeInitRate?: number;
  /** The root volume's throughput and IOPS above gp3's baseline (services/boxVolumePerformance.ts), before fitting to its size; unset: baseline. */
  volumePerformance?: VolumePerformance;
}

/** What a launch got, for its record, its log line and its span. */
export interface LaunchedInstance {
  instanceId: string;
  hibernationConfigured: boolean;
  instanceType: string;
  subnetId: string;
  /** From RunInstances' Placement; null if it gave none. */
  availabilityZone: string | null;
  /** The rate the root volume was created with; unset when none was asked for or EBS refused it. */
  volumeInitRate?: number;
  /** The throughput and IOPS the root volume was created with, fitted to its size; unset: gp3's baseline. */
  volumePerformance?: VolumePerformance;
}

/** Where the next launch's subnet walk starts, so launches spread across every subnet instead of filling the first. */
let nextSubnet = 0;

/** Test hook: the next launch starts at the first subnet again. */
export function resetSubnetRotationForTests(): void {
  nextSubnet = 0;
}

/**
 * Where a launch may go, in the order it tries them: the configured type in
 * every subnet, then each fallback type. The subnets are walked from `start`
 * (mod their count), wrapping around, so every subnet gets its turn first.
 */
export function launchCandidates(
  cfg: Pick<BoxConfig, 'instanceType' | 'fallbackInstanceTypes' | 'subnetId' | 'fallbackSubnetIds'>,
  start = 0,
): { instanceType: string; subnetId: string }[] {
  const pool = [cfg.subnetId, ...cfg.fallbackSubnetIds];
  const at = start % pool.length;
  const subnets = [...pool.slice(at), ...pool.slice(0, at)];
  return [cfg.instanceType, ...cfg.fallbackInstanceTypes].flatMap(instanceType => subnets.map(subnetId => ({ instanceType, subnetId })));
}

/**
 * RunInstances refusals that say "not here, not this type" rather than "not
 * at all". VcpuLimitExceeded is deliberately absent: the Graviton general
 * purpose types share one quota bucket, so another type or AZ hits it too.
 */
export function isCapacityRefusal(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  if (name === 'InsufficientInstanceCapacity' || name === 'InsufficientFreeAddressesInSubnet') return true;
  // "Your requested instance type (x) is not supported in your requested Availability Zone"
  return name === 'Unsupported' && /availability zone/i.test(errMsg(err));
}

/**
 * Launch at the first candidate EC2 has room for. Each type gets its own
 * hibernation plan, since the root volume grows by that type's RAM. Any error
 * other than a capacity refusal ends the walk, as does the last candidate's.
 */
export async function runInstanceWithFallback(
  ec2: EC2Client,
  boxName: string,
  hibernationEnabled: boolean,
  a: Omit<RunArgs, 'hibernation' | 'instanceType' | 'subnetId'>,
  /** Start the subnet walk here (an environment pool balances its zones itself); unset: the rotation. */
  startSubnetId?: string | null,
): Promise<LaunchedInstance> {
  const pool = [a.cfg.subnetId, ...a.cfg.fallbackSubnetIds];
  const preferred = startSubnetId ? pool.indexOf(startSubnetId) : -1;
  const candidates = launchCandidates(a.cfg, preferred >= 0 ? preferred : nextSubnet++);
  const plans = new Map<string, HibernationPlan>();
  for (const [i, { instanceType, subnetId }] of candidates.entries()) {
    let hibernation = plans.get(instanceType);
    if (!hibernation) {
      hibernation = await planBoxHibernation(ec2, instanceType, a.ami, hibernationEnabled);
      plans.set(instanceType, hibernation);
      if (hibernation.reason) console.log(`[BOX] ${boxName}: launching ${instanceType} without hibernation: ${hibernation.reason}`);
    }
    try {
      const launched = await runInstance(ec2, { ...a, hibernation, instanceType, subnetId });
      if (i > 0) console.log(`[BOX] ${boxName}: launched on fallback ${instanceType} in ${subnetId}`);
      return { ...launched, instanceType, subnetId };
    } catch (err) {
      if (i === candidates.length - 1 || !isCapacityRefusal(err)) throw err;
      console.warn(`[BOX] ${boxName}: no ${instanceType} capacity in ${subnetId} (${errMsg(err)}); trying the next`);
    }
  }
  throw new Error('no launch candidates');
}

type Launched = Omit<LaunchedInstance, 'instanceType' | 'subnetId'>;

/**
 * Launch the instance. A launch EBS refuses the root volume's initialization
 * rate for (capacity, or the regional quota), or its throughput and IOPS, is
 * retried without what it refused, each at most once: they are speed-ups, the
 * box is not.
 */
async function runInstance(ec2: EC2Client, a: RunArgs): Promise<Launched> {
  try {
    return await runInstanceHibernating(ec2, a);
  } catch (err) {
    if (a.volumeInitRate && isVolumeInitRateRefusal(err)) {
      console.warn(`[BOX] ${a.name}: EBS refused the ${a.volumeInitRate} MiB/s volume initialization rate (${errMsg(err)}); launching without it`);
      return runInstance(ec2, { ...a, volumeInitRate: undefined });
    }
    if (a.volumePerformance && isVolumePerformanceRefusal(err)) {
      const { throughput, iops } = effectiveVolumePerformance(a.volumePerformance);
      console.warn(`[BOX] ${a.name}: EBS refused the root volume's ${throughput} MiB/s and ${iops} IOPS (${errMsg(err)}); launching at gp3's baseline`);
      return runInstance(ec2, { ...a, volumePerformance: undefined });
    }
    throw err;
  }
}

/**
 * A hibernation-configured launch EC2 rejects (an account-level restriction,
 * a type or volume shape it won't hibernate) is retried once without it:
 * hibernation is a nicety, the box is not.
 */
async function runInstanceHibernating(ec2: EC2Client, a: RunArgs): Promise<Launched> {
  const once = async (hibernate: boolean): Promise<Launched> => {
    const { instanceId, availabilityZone } = await runInstanceOnce(ec2, a, hibernate);
    return {
      instanceId, availabilityZone, hibernationConfigured: hibernate, volumeInitRate: a.volumeInitRate,
      volumePerformance: rootVolumePerformance(a, hibernate),
    };
  };
  if (!a.hibernation.configured) return once(false);
  try {
    return await once(true);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name !== 'UnsupportedHibernationConfiguration' && !/hibernat/i.test(errMsg(err))) throw err;
    console.warn(`[BOX] ${a.name}: EC2 rejected the hibernation launch (${errMsg(err)}); launching without it`);
    return once(false);
  }
}

/** The root volume's size: the AMI's floor, or that plus the type's RAM for a hibernation-configured launch. */
function rootVolumeGb(a: Pick<RunArgs, 'ami' | 'hibernation'>, hibernate: boolean): number {
  return hibernate ? a.hibernation.rootVolumeGb : a.ami.rootVolumeGb;
}

/** The throughput and IOPS the root volume asks for, fitted to its size; undefined: gp3's baseline. */
function rootVolumePerformance(a: Pick<RunArgs, 'ami' | 'hibernation' | 'volumePerformance'>, hibernate: boolean) {
  return volumePerformanceFor(a.volumePerformance, rootVolumeGb(a, hibernate));
}

/**
 * The root device's Ebs block, the one place it is built. Encrypted is also
 * a hard requirement of hibernation.
 */
export function rootEbs(a: Pick<RunArgs, 'ami' | 'hibernation' | 'volumeInitRate' | 'volumePerformance'>, hibernate: boolean): EbsBlockDevice {
  const perf = rootVolumePerformance(a, hibernate);
  return {
    VolumeSize: rootVolumeGb(a, hibernate),
    VolumeType: 'gp3',
    Encrypted: true,
    DeleteOnTermination: true,
    // EBS copies the whole snapshot in at this rate, in place of loading
    // each block on first read (and of FSR, where that is on too).
    ...(a.volumeInitRate ? { VolumeInitializationRate: a.volumeInitRate } : {}),
    // Above gp3's 125 MiB/s and 3,000 IOPS; left out, the volume gets those.
    ...(perf?.throughput ? { Throughput: perf.throughput } : {}),
    ...(perf?.iops ? { Iops: perf.iops } : {}),
  };
}

async function runInstanceOnce(ec2: EC2Client, a: RunArgs, hibernate: boolean): Promise<{ instanceId: string; availabilityZone: string | null }> {
  const cmd = new RunInstancesCommand({
    ImageId: a.ami.imageId,
    InstanceType: a.instanceType as any,
    MinCount: 1,
    MaxCount: 1,
    SubnetId: a.subnetId,
    SecurityGroupIds: [a.securityGroupId],
    IamInstanceProfile: { Name: a.iamRoleName },
    MetadataOptions: {
      HttpEndpoint: 'enabled',
      HttpTokens: 'required',          // IMDSv2 only
      HttpPutResponseHopLimit: 2,
    },
    BlockDeviceMappings: [{ DeviceName: a.ami.rootDeviceName, Ebs: rootEbs(a, hibernate) }],
    ...(hibernate ? { HibernationOptions: { Configured: true } } : {}),
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
      // The shared Bazel cache's S3 access logs name readers by source IP
      // only, so each launch's address is logged for the IP-to-box history.
      console.log(`[BOX] ${a.name}: ${id} launched with private IP ${res.Instances?.[0]?.PrivateIpAddress ?? 'unknown'} in ${a.subnetId}`);
      return { instanceId: id, availabilityZone: res.Instances?.[0]?.Placement?.AvailabilityZone ?? null };
    } catch (err) {
      lastErr = err;
      const name = err instanceof Error ? err.name : '';
      // Refusals of the launch's shape are the caller's to retry without it, not eventual consistency.
      const aboutShape = /hibernat/i.test(errMsg(err)) || isVolumeInitRateRefusal(err)
        || (!!a.volumePerformance && isVolumePerformanceRefusal(err));
      if (!aboutShape && (name === 'InvalidParameterValue' || name === 'InvalidIamInstanceProfile')) {
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

async function markFailed(instanceId: string, error: string, status: 'failed' | 'env-failed' = 'failed'): Promise<void> {
  // Never over a terminated row: a launch that fails after the user deleted
  // the box would otherwise move it out of `terminated`, where neither the
  // user nor the teardown sweep would look for its resources again. Nor over
  // a quarantined one, which `failed` would hand back to its owner's Retry.
  await prisma.instance.updateMany({
    where: { id: instanceId, status: { notIn: ['terminated', QUARANTINED] } },
    // An environment pool box's failure is its pool's (env-failed, with the reason as its log).
    // An environment pool box's launch failed, not its setup: it only delays the next launch (services/envPoolPlanner.ts).
    data: { status, provisioningError: error.slice(0, 1000), ...(status === 'env-failed' ? { poolLog: error.slice(0, 4000), poolSetupFailed: false, terminatedAt: new Date() } : {}) },
  }).catch(e => console.error(`[BOX] Failed to mark instance ${instanceId} failed:`, e.message));
}

async function isQuarantinedNow(instanceId: string): Promise<boolean> {
  const row = await prisma.instance.findUnique({ where: { id: instanceId }, select: { status: true } });
  return row?.status === QUARANTINED;
}

// ── Boxes created on an owner's behalf ───────────────────────────────────────
//
// The first-login auto-provision that lived here left with #226 (a managed box
// now needs a stored GitHub token, through the Add box flow). What remains is
// the create the Claude runner spawn uses for an owner with no box
// (routes/claudeRunner.ts), behind its flag and under its per-owner lock.

/**
 * Given the set of names ALL of a user's instances already hold — including
 * terminated ones, which still occupy the (userId, name) unique index — return
 * a free name: the base if unused, else base-2, base-3, … .
 *
 * Pure so it can be unit-tested; resolveFreeBoxName supplies the taken set.
 */
export function pickFreeBoxName(taken: Set<string>, base: string): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Astronomically unlikely (1000 terminated boxes on one name); a random
  // suffix guarantees we never loop and never trip the unique index.
  return `${base}-${randomBytes(3).toString('hex')}`;
}

/**
 * Pick a box name that is free across ALL of the user's instances, including
 * terminated ones. Without this, a user who terminated their auto box (say
 * "default") would, on every later login, pass the zero-active-boxes pre-check,
 * attempt to re-create "default", and trip P2002 forever — never getting a
 * replacement box despite an empty dashboard.
 *
 * Reads inside the caller's transaction (`tx`) so the name is resolved from the
 * same snapshot as the caller's `stillNeeded` re-check: two concurrent creates
 * then resolve the same name and collide on the unique index (P2002), or
 * conflict under serializable isolation (P2034), and exactly one wins.
 */
async function resolveFreeBoxName(
  tx: Prisma.TransactionClient,
  userId: string,
  base: string,
): Promise<string> {
  const taken = new Set(
    (await tx.instance.findMany({ where: { userId }, select: { name: true } })).map((i) => i.name),
  );
  return pickFreeBoxName(taken, base);
}

// Only the fields a create needs — decoupled from Express.User / the full
// Prisma User so any caller can pass either.
export interface BoxOwner {
  id: string;
  googleEmail: string;
  unixUsername: string;
  displayName: string;
}

/**
 * A new box for `user`, named `baseName` or the first free base-2, base-3, …
 * and provisioned async like POST /api/instances. For a caller that has
 * decided on its own that the user needs one: the Claude runner spawn
 * (routes/claudeRunner.ts), behind its flag and under its per-owner lock,
 * which is what keeps a burst of sessions in one process to one box.
 *
 * `stillNeeded` is asked again INSIDE the serializable transaction, with the
 * owner's non-terminated boxes as that snapshot sees them. The lock covers
 * this process only, and the free name dodges every existing row, so without
 * the re-check a second process that had also decided to acquire would suffix
 * the name and buy a second box instead of hitting the unique index. Two
 * creates that both pass the re-check conflict under serializable isolation
 * (P2034, isConcurrentCreate), which the caller treats as "one is on its way".
 * Returns the box name; null when box provisioning is not configured or
 * `stillNeeded` said no. Persistence errors are thrown. `size` (boxSize.ts)
 * is recorded on the row, and the launch walks its types unless
 * `launch.instanceTypes` names others; null is BOX_INSTANCE_TYPE.
 */
export async function provisionNewBox(
  user: BoxOwner,
  baseName: string,
  stillNeeded: (owned: OwnedBoxRow[]) => boolean,
  launch: LaunchChoices,
  size: BoxSize | null = null,
): Promise<string | null> {
  if (!isBoxProvisioningConfigured()) return null;
  const created = await createBoxRow(user, baseName, stillNeeded, size);
  if (!created) return null;
  console.log(`[BOX] Provisioning box "${created.boxName}" for ${user.googleEmail}${size ? ` (${size})` : ''}`);
  launchCreatedBox(user, created, { ...launch, instanceTypes: launch.instanceTypes ?? instanceTypesForSize(size) });
  return created.boxName;
}

/** The owner's flags a launch needs decided (ProvisionArgs), read by the caller with its claim decision. */
export type LaunchChoices = Pick<ProvisionArgs, 'image' | 'instanceTypes' | 'flavor'>;

/** P2002 (the (userId, name) unique index) or P2034 (serialization failure): another create won. */
export function isConcurrentCreate(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2002' || err.code === 'P2034');
}

interface CreatedBox { instance: Instance; boxName: string; rawToken: string }

/**
 * One EC2 Instance (+ per-box token) for `user`, in ONE serializable
 * transaction. The name dodges terminated rows still holding the (userId,
 * name) unique index, so a user who terminated a box named `baseName` gets
 * base-2, … instead of a P2002 on every attempt; it is read in-transaction so
 * it shares the snapshot of the `stillNeeded` re-check. Null when `stillNeeded`,
 * asked with the owner's non-terminated boxes as this transaction sees them,
 * says the box is no longer wanted.
 */
async function createBoxRow(
  user: BoxOwner,
  baseName: string,
  stillNeeded: (owned: OwnedBoxRow[]) => boolean,
  size: BoxSize | null,
): Promise<CreatedBox | null> {
  const rawToken = 'tmag_' + randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const tokenPrefix = rawToken.substring(0, 13) + '...';
  return prisma.$transaction(
    async (tx) => {
      // Authoritative re-check inside the snapshot: the caller's own look at
      // the user's boxes predates this transaction.
      const owned = await tx.instance.findMany({
        where: { userId: user.id, status: { not: 'terminated' } },
        select: OWNED_BOX_SELECT,
      });
      if (!stillNeeded(owned)) return null;
      const boxName = await resolveFreeBoxName(tx, user.id, baseName);
      const inst = await tx.instance.create({
        data: { userId: user.id, name: boxName, kind: 'ec2', status: 'provisioning', size },
      });
      await tx.agentToken.create({
        data: {
          userId: user.id,
          instanceId: inst.id,
          name: `box: ${boxName}`,
          tokenHash,
          tokenPrefix,
        },
      });
      return { instance: inst, boxName, rawToken };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

function launchCreatedBox(user: BoxOwner, { instance, boxName, rawToken }: CreatedBox, launch: LaunchChoices): void {
  // Fire-and-forget the slow EC2 launch (provisionBox marks the box `failed`
  // on any error and never throws).
  void provisionBox({
    instance,
    boxName,
    owner: user.googleEmail,
    token: rawToken,
    remoteUnixUser: user.unixUsername,
    gitUserEmail: user.googleEmail,
    gitUserName: user.displayName,
    ...launch,
  });
}

// ── Termination ──────────────────────────────────────────────────────────────

/**
 * Tear down a box's AWS resources. Idempotent: a resource already gone counts
 * as done (NotFound / NoSuchEntity), so re-running a finished or half-done
 * teardown is a handful of cheap calls. Every step runs even when an earlier
 * one failed, so a partially-provisioned box cleans up as far as it can.
 *
 * Fired un-awaited by the terminate route and pool retirement, which mark the
 * row `terminated` first; a restart can therefore cut this short. Only a run
 * in which every step succeeded stamps cleanedUpAt, and the provisioning sweep
 * (sweepUncleanedTeardowns) re-runs teardown for terminated rows without it.
 * Resolves to whether this run finished the teardown. Never throws.
 */
export async function terminateBox(instance: Instance): Promise<boolean> {
  const cfg = getBoxConfig();
  if (!cfg) return false;

  try {
    await prisma.instance.update({ where: { id: instance.id }, data: { cleanupAttemptedAt: new Date() } });
  } catch (err) {
    console.error(`[BOX] could not stamp teardown start for ${instance.id}:`, errMsg(err));
  }

  const region = instance.region ?? cfg.region;
  const ec2 = new EC2Client(awsClientConfig(cfg, region));
  const iam = new IAMClient(awsClientConfig(cfg, region));
  // Deterministic, so the role is torn down even when the launch was cut
  // short between CreateRole and writing iamRoleName.
  const name = instance.iamRoleName ?? `${cfg.resourcePrefix}-${instance.id}`;
  const profileName = instance.iamInstanceProfileName ?? name;
  let clean = true;

  // 1. Terminate the EC2 instance and wait for it to go away — the SG can't be
  //    deleted while an ENI references it.
  if (instance.ec2InstanceId) {
    clean = (await terminateInstance(ec2, instance.ec2InstanceId)) && clean;
  }

  // 2. Revoke every :3040 ingress rule that still points at the box SG, then
  //    delete the box SG. EC2 refuses to delete a SG another SG's rule
  //    references (DependencyViolation), and that referencing SG is not
  //    necessarily this deployment's HOST_SECURITY_GROUP_ID: a box provisioned
  //    by the EC2-hosted orchestrator carries a rule on the old host SG, while
  //    the container orchestrator runs with the env var intentionally unset.
  //    So rather than trust the static config we ask EC2 which SGs reference
  //    the box SG and revoke from each of them (plus the configured host SG,
  //    if any — also the fallback when the lookup itself fails). A failed
  //    revoke is logged; the SG delete that follows is what decides whether
  //    this step is done.
  //    Requires the provisioner's IAM grant to allow RevokeSecurityGroupIngress
  //    on those SGs — the terraform module exposes that separately.
  if (instance.securityGroupId) {
    clean = (await releaseSecurityGroup(ec2, cfg, instance.securityGroupId)) && clean;
  }

  // 3. Detach/delete the role + instance profile.
  clean = (await deleteBoxRole(iam, name, profileName)) && clean;

  if (!clean) {
    console.error(`[BOX] Teardown of ${instance.name} (${instance.id}) incomplete; the provisioning sweep retries it`);
    return false;
  }

  // Guarded on the handles this run saw: a launch still running when the box
  // was terminated may have created (and recorded) more since, and stamping
  // over that would hide it from the sweep.
  try {
    const stamped = await prisma.instance.updateMany({
      where: {
        id: instance.id,
        status: 'terminated',
        // What this run read: null, or the stamp a failed launch's release left (releaseFailedLaunch).
        cleanedUpAt: instance.cleanedUpAt ?? null,
        ec2InstanceId: instance.ec2InstanceId,
        securityGroupId: instance.securityGroupId,
        iamRoleName: instance.iamRoleName,
        iamInstanceProfileName: instance.iamInstanceProfileName,
      },
      data: { cleanedUpAt: new Date() },
    });
    if (stamped.count === 0) {
      console.log(`[BOX] Teardown of ${instance.name} (${instance.id}) finished, but the row changed meanwhile; the provisioning sweep checks it again`);
      return false;
    }
  } catch (err) {
    console.error(`[BOX] could not record teardown of ${instance.id}:`, errMsg(err));
    return false;
  }
  console.log(`[BOX] Terminated box resources for ${instance.name}`);
  return true;
}

/** Revoke every :3040 ingress rule that points at the box SG, then delete it (terminateBox step 2). */
async function releaseSecurityGroup(ec2: EC2Client, cfg: BoxConfig, boxSgId: string): Promise<boolean> {
  let referencing: string[] = [];
  try {
    referencing = await findSecurityGroupsReferencing(ec2, boxSgId);
  } catch (err) {
    console.error(`[BOX] describe SGs referencing ${boxSgId} failed; falling back to HOST_SECURITY_GROUP_ID:`, errMsg(err));
  }
  for (const groupId of revokeTargets(cfg.hostSecurityGroupId, referencing, boxSgId)) {
    try {
      await ec2.send(new RevokeSecurityGroupIngressCommand({
        GroupId: groupId,
        IpPermissions: [{
          IpProtocol: 'tcp', FromPort: 3040, ToPort: 3040,
          UserIdGroupPairs: [{ GroupId: boxSgId }],
        }],
      }));
    } catch (err) {
      if (isAwsNotFound(err, EC2_PERMISSION_NOT_FOUND) || isAwsNotFound(err, EC2_GROUP_NOT_FOUND)) continue;
      console.error(`[BOX] revoke :3040 ingress from ${groupId} for ${boxSgId} failed:`, errMsg(err));
    }
  }
  return deleteSgWithRetry(ec2, boxSgId);
}

async function terminateInstance(ec2: EC2Client, instanceId: string): Promise<boolean> {
  try {
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  } catch (err) {
    if (isAwsNotFound(err, EC2_INSTANCE_NOT_FOUND)) return true;
    console.error(`[BOX] terminate instance ${instanceId} failed:`, errMsg(err));
    return false;
  }
  if (await waitForTerminated(ec2, instanceId)) return true;
  console.error(`[BOX] instance ${instanceId} still not terminated after waiting`);
  return false;
}

/**
 * Delete the per-box role, its instance profile and its policies. Each call
 * answering NoSuchEntity is done, not failed. Inline policies are listed
 * rather than named, so whatever a launch or a later backfill put on the role
 * goes too: DeleteRole refuses while any remain.
 */
async function deleteBoxRole(iam: IAMClient, name: string, profileName: string): Promise<boolean> {
  let ok = true;
  const step = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      if (isAwsNotFound(err, IAM_NOT_FOUND)) return;
      ok = false;
      console.error(`[BOX] ${what} for ${name} failed:`, errMsg(err));
    }
  };

  await step('remove role from instance profile', () => iam.send(new RemoveRoleFromInstanceProfileCommand({ InstanceProfileName: profileName, RoleName: name })));
  await step('delete instance profile', () => iam.send(new DeleteInstanceProfileCommand({ InstanceProfileName: profileName })));
  await step('detach SSM core policy', () => iam.send(new DetachRolePolicyCommand({ RoleName: name, PolicyArn: SSM_CORE_POLICY_ARN })));
  for (const policyName of await inlinePolicyNames(iam, name)) {
    await step(`delete inline policy ${policyName}`, () => iam.send(new DeleteRolePolicyCommand({ RoleName: name, PolicyName: policyName })));
  }
  await step('delete role', () => iam.send(new DeleteRoleCommand({ RoleName: name })));
  return ok;
}

/**
 * The role's inline policy names. Falls back to the ones this file writes
 * when listing fails, so the common shape still tears down; anything else left
 * on the role then fails DeleteRole and the sweep retries.
 */
async function inlinePolicyNames(iam: IAMClient, roleName: string): Promise<string[]> {
  const names = new Set<string>();
  try {
    let marker: string | undefined;
    do {
      const res = await iam.send(new ListRolePoliciesCommand({ RoleName: roleName, Marker: marker }));
      for (const n of res.PolicyNames ?? []) names.add(n);
      marker = res.IsTruncated ? res.Marker : undefined;
    } while (marker);
  } catch (err) {
    if (isAwsNotFound(err, IAM_NOT_FOUND)) return [];
    console.error(`[BOX] list inline policies for ${roleName} failed:`, errMsg(err));
    names.add(GIT_TOKEN_INLINE_POLICY);
    names.add(BOX_ECR_PULL_INLINE_POLICY);
    names.add(QUARANTINE_DENY_POLICY);
  }
  return [...names];
}

/**
 * Bring every live box role's ECR pull policy up to the current config, so
 * boxes launched before BOX_ECR_PULL_REPOSITORY_ARNS was set (or under an
 * older repository list) get the same grant a new box does. Idempotent: reads
 * each role's policy first and writes only when it differs. Run once at
 * startup; a box launched after that gets the policy from createBoxRole.
 *
 * With the setting unset this does nothing, and in particular does not strip
 * policies a previous config wrote: turning the grant off for existing boxes
 * is a deliberate IAM change, not a side effect of a missing env var.
 */
export async function backfillBoxEcrPullPolicies(): Promise<void> {
  const cfg = getBoxConfig();
  if (!cfg?.ecrPull) return;
  const desired = boxEcrPullPolicyDocument(cfg.ecrPull);

  const boxes = await prisma.instance.findMany({
    where: { kind: 'ec2', iamRoleName: { not: null }, status: { not: 'terminated' } },
    select: { id: true, name: true, region: true, iamRoleName: true },
  });

  let updated = 0;
  let failed = 0;
  for (const box of boxes) {
    const roleName = box.iamRoleName!;
    const iam = new IAMClient(awsClientConfig(cfg, box.region ?? cfg.region));
    try {
      let current: string | undefined;
      try {
        const res = await iam.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: BOX_ECR_PULL_INLINE_POLICY }));
        current = res.PolicyDocument;
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
      if (!ecrPullPolicyNeedsUpdate(current, desired)) continue;
      await iam.send(new PutRolePolicyCommand({ RoleName: roleName, PolicyName: BOX_ECR_PULL_INLINE_POLICY, PolicyDocument: desired }));
      updated++;
    } catch (err) {
      // A role already deleted by a teardown in flight is not a failure.
      if (isNoSuchEntity(err)) continue;
      failed++;
      console.error(`[BOX] ECR pull policy backfill failed for ${box.name} (${roleName}):`, errMsg(err));
    }
  }
  console.log(`[BOX] ECR pull policy backfill: ${updated} updated, ${boxes.length - updated - failed} already current or gone, ${failed} failed`);
}

/**
 * Security groups that still hold an ingress rule referencing `boxSgId`. The
 * `ip-permission.group-id` filter matches any ingress UserIdGroupPair, which is
 * exactly the shape authorizeHostIngress writes. The box SG itself is excluded
 * (a self-referencing rule is not what blocks deletion).
 */
export async function findSecurityGroupsReferencing(ec2: EC2Client, boxSgId: string): Promise<string[]> {
  const res = await ec2.send(new DescribeSecurityGroupsCommand({
    Filters: [{ Name: 'ip-permission.group-id', Values: [boxSgId] }],
  }));
  return (res.SecurityGroups ?? [])
    .map((sg) => sg.GroupId)
    .filter((id): id is string => !!id && id !== boxSgId);
}

/**
 * The SGs terminateBox revokes the box's :3040 ingress rule from: the
 * configured host SG (if any) plus every SG EC2 reports as still referencing
 * the box SG, de-duplicated and never the box SG itself. Pure so the policy
 * can be unit-tested without an EC2 client.
 */
export function revokeTargets(hostSecurityGroupId: string | undefined, referencing: string[], boxSgId: string): string[] {
  const targets = new Set<string>();
  if (hostSecurityGroupId) targets.add(hostSecurityGroupId);
  for (const id of referencing) targets.add(id);
  targets.delete(boxSgId);
  return [...targets];
}

/** Whether the instance reached `terminated` (or stopped being describable) within ~5 minutes. */
async function waitForTerminated(ec2: EC2Client, instanceId: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      const state = res.Reservations?.[0]?.Instances?.[0]?.State?.Name;
      if (!state || state === 'terminated') return true;
    } catch (err) {
      if (isAwsNotFound(err, EC2_INSTANCE_NOT_FOUND)) return true;
    }
    await sleep(5000);
  }
  return false;
}

async function deleteSgWithRetry(ec2: EC2Client, sgId: string): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    try {
      await ec2.send(new DeleteSecurityGroupCommand({ GroupId: sgId }));
      return true;
    } catch (err) {
      if (isAwsNotFound(err, EC2_GROUP_NOT_FOUND)) return true;
      // DependencyViolation while the terminated ENI lingers — back off.
      if (i === 5) { console.error(`[BOX] delete SG ${sgId} failed:`, errMsg(err)); return false; }
      await sleep(10000);
    }
  }
  return false;
}

// ── Stuck-provisioning sweep ─────────────────────────────────────────────────

/** 15 min with no agent → failed. The Claude runner's auto-box hold assumes this window (claudeRunnerSpawn.ts). */
export const STUCK_AFTER_MS = 15 * 60 * 1000;
// Generous because clones and image pulls are slow. Measure and tighten.
const WARM_INCOMPLETE_AFTER_MS = 45 * 60 * 1000;
let sweepTimer: NodeJS.Timeout | null = null;

const WARMING_FAILURE_TEXT: Readonly<Record<StuckWarmingReason, string>> = {
  'no-agent': 'Warm box never connected within 15 minutes of provisioning',
  'incomplete': 'Warm box did not finish its on-warm run within 45 minutes',
};

/**
 * Periodically flip boxes that have been `provisioning` for too long without
 * their agent ever dialing in to `failed`. (registerAgent flips healthy boxes
 * to `ready`, so anything still provisioning past the window is stuck.) Pool
 * boxes get the same treatment with their own two windows. Terminated boxes
 * whose teardown never finished get it re-run (sweepUncleanedTeardowns), and
 * failed launches that never got an instance give back their SG and IAM role
 * (sweepFailedLaunches).
 */
export function startProvisioningSweep(intervalMs = provisioningSweepIntervalMs()): void {
  if (sweepTimer) return;
  const tick = async () => {
    try {
      const now = new Date();
      const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);
      const stuck = await prisma.instance.updateMany({
        where: { status: 'provisioning', createdAt: { lt: cutoff } },
        data: { status: 'failed', provisioningError: 'Box never connected within 15 minutes of provisioning' },
      });
      if (stuck.count > 0) console.log(`[BOX] Swept ${stuck.count} stuck-provisioning box(es) → failed`);
      await sweepStuckWarming(now);
    } catch (err) {
      failRoot(err);
      console.error('[BOX] Provisioning sweep failed:', errMsg(err));
    }
    try {
      await sweepUncleanedTeardowns(new Date());
    } catch (err) {
      failRoot(err);
      console.error('[BOX] Teardown sweep failed:', errMsg(err));
    }
    try {
      await sweepFailedLaunches(new Date());
    } catch (err) {
      failRoot(err);
      console.error('[BOX] Failed-launch sweep failed:', errMsg(err));
    }
    try {
      const { sweepUncontainedQuarantines } = await import('./boxQuarantine');
      await sweepUncontainedQuarantines();
    } catch (err) {
      failRoot(err);
      console.error('[QUARANTINE] Containment sweep failed:', errMsg(err));
    }
  };
  sweepTimer = setInterval(traceSweep('provisioning', tick), intervalMs);
  sweepTimer.unref?.();
}

/**
 * Fail the `warming` boxes that are never going to become claimable.
 *
 * One line and one update per box rather than an updateMany, because the
 * reconciler's breaker counts these failures and an operator reading a
 * breaker-open line needs to be able to find the boxes that fed it.
 */
async function sweepStuckWarming(now: Date): Promise<void> {
  const candidates = await prisma.instance.findMany({
    where: { status: 'warming', createdAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) } },
    select: { id: true, name: true, createdAt: true, lastConnectedAt: true },
  });

  for (const box of candidates) {
    const reason = stuckWarmingReason({
      createdAt: box.createdAt,
      lastConnectedAt: box.lastConnectedAt,
      now,
      noAgentAfterMs: STUCK_AFTER_MS,
      incompleteAfterMs: WARM_INCOMPLETE_AFTER_MS,
    });
    if (!reason) continue;
    const error = WARMING_FAILURE_TEXT[reason];
    // Guarded on `warming` rather than going through markFailed, because a box
    // that connected and warmed between the select above and this write is a
    // box the pool can hand out. Losing the sweep to it is the right outcome.
    const failed = await prisma.instance.updateMany({
      where: { id: box.id, status: 'warming' },
      data: { status: 'failed', provisioningError: error },
    });
    if (failed.count > 0) console.log(`[POOL] fail ${box.id} (${box.name}): ${error}`);
  }
}

/**
 * Re-run teardown for terminated ec2 boxes whose last teardown did not finish
 * (cleanedUpAt null) and has not started within BOX_TEARDOWN_RETRY_SECONDS, a
 * few per tick, longest-unattempted first so a box that keeps failing cannot
 * starve the rest. Each is claimed by stamping cleanupAttemptedAt under the
 * same filter, so a row is never torn down twice at once, and its teardown
 * runs in the background like the route's. Returns how many were started.
 */
export async function sweepUncleanedTeardowns(now: Date, limit = TEARDOWN_SWEEP_BATCH): Promise<number> {
  if (!isBoxProvisioningConfigured()) return 0;
  const where = teardownCandidatesWhere(now, teardownRetryAfterMs());
  const candidates = await prisma.instance.findMany({
    where,
    orderBy: [{ cleanupAttemptedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: limit,
  });

  let started = 0;
  for (const box of candidates) {
    const claimed = await prisma.instance.updateMany({ where: { ...where, id: box.id }, data: { cleanupAttemptedAt: now } });
    if (claimed.count === 0) continue;
    started++;
    const last = box.cleanupAttemptedAt ? `last attempt ${box.cleanupAttemptedAt.toISOString()}` : 'never attempted';
    console.log(`[BOX] teardown retry ${box.id} (${box.name}): terminated ${box.terminatedAt?.toISOString() ?? 'at an unknown time'}, ${last}`);
    void terminateBox(box);
  }
  return started;
}

/**
 * Release what a launch that never got an instance left behind: its security
 * group (and the host's :3040 rule on it), its instance profile and its role.
 * The row stays `failed`, for the owner's Retry and the warm pool's breaker,
 * with cleanedUpAt stamped. Skipped, for an operator, when EC2 has a live
 * instance under the box's name after all (a RunInstances whose answer was
 * lost): deleting its role would strand it. Resolves to whether every
 * resource is gone. Never throws.
 */
export async function releaseFailedLaunch(instance: Instance): Promise<boolean> {
  const cfg = getBoxConfig();
  if (!cfg) return false;
  const region = instance.region ?? cfg.region;
  const ec2 = new EC2Client(awsClientConfig(cfg, region));
  const iam = new IAMClient(awsClientConfig(cfg, region));
  const name = instance.iamRoleName ?? `${cfg.resourcePrefix}-${instance.id}`;
  const profileName = instance.iamInstanceProfileName ?? name;

  try {
    const live = await liveInstancesNamed(ec2, `${cfg.resourcePrefix}-${instance.id}`);
    if (live.length > 0) {
      console.warn(`[BOX] ${instance.name} (${instance.id}) failed with no recorded instance, but EC2 has ${live.join(', ')} under its name; leaving its SG and role for an operator`);
      return false;
    }
  } catch (err) {
    console.error(`[BOX] could not check ${instance.name} (${instance.id}) for an unrecorded instance; not releasing it:`, errMsg(err));
    return false;
  }

  let clean = true;
  if (instance.securityGroupId) clean = (await releaseSecurityGroup(ec2, cfg, instance.securityGroupId)) && clean;
  clean = (await deleteBoxRole(iam, name, profileName)) && clean;
  if (!clean) {
    console.error(`[BOX] Releasing failed launch ${instance.name} (${instance.id}) incomplete; the provisioning sweep retries it`);
    return false;
  }

  try {
    const stamped = await prisma.instance.updateMany({
      where: {
        id: instance.id,
        status: 'failed',
        cleanedUpAt: null,
        ec2InstanceId: null,
        securityGroupId: instance.securityGroupId,
        iamRoleName: instance.iamRoleName,
        iamInstanceProfileName: instance.iamInstanceProfileName,
      },
      data: { cleanedUpAt: new Date() },
    });
    if (stamped.count === 0) return false;
  } catch (err) {
    console.error(`[BOX] could not record the release of ${instance.id}:`, errMsg(err));
    return false;
  }
  console.log(`[BOX] Released the SG and IAM role of failed launch ${instance.name} (${instance.id})`);
  return true;
}

/** EC2 instances tagged Name=`name` that are not (being) terminated. */
async function liveInstancesNamed(ec2: EC2Client, name: string): Promise<string[]> {
  const res = await ec2.send(new DescribeInstancesCommand({
    Filters: [
      { Name: 'tag:Name', Values: [name] },
      { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
    ],
  }));
  return (res.Reservations ?? []).flatMap(r => r.Instances ?? []).map(i => i.InstanceId).filter((id): id is string => !!id);
}

/**
 * Release the SG and IAM role of failed launches that never got an instance
 * (failedLaunchLeftoversWhere), a few per tick, longest-unattempted first,
 * never one whose launch is still running here (launchesInFlight).
 * Claimed through cleanupAttemptedAt like sweepUncleanedTeardowns. Awaited
 * one at a time: each is quick, and a backlog must not trip IAM throttling.
 */
export async function sweepFailedLaunches(now: Date, limit = FAILED_LAUNCH_SWEEP_BATCH): Promise<number> {
  if (!isBoxProvisioningConfigured()) return 0;
  const where = failedLaunchLeftoversWhere(now, teardownRetryAfterMs());
  const candidates = await prisma.instance.findMany({
    where,
    orderBy: [{ cleanupAttemptedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: limit,
  });

  let released = 0;
  for (const box of candidates) {
    if (launchesInFlight.has(box.id)) continue;
    const claimed = await prisma.instance.updateMany({ where: { ...where, id: box.id }, data: { cleanupAttemptedAt: now } });
    if (claimed.count === 0) continue;
    if (await releaseFailedLaunch(box)) released++;
  }
  return released;
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

function isNoSuchEntity(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  return name === 'NoSuchEntity' || name === 'NoSuchEntityException';
}
