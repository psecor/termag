/**
 * Instances (boxes) — CRUD for per-user compute boxes.
 *
 * V2 design: orchestrator-driven provisioning. POST creates the Instance row +
 * a per-box bearer token, then kicks off async EC2 provisioning via the AWS SDK
 * (boxProvisioner) and returns immediately with `status: provisioning`. The box
 * boots, cloud-init starts the agent, the agent dials the WS, and
 * agentRegistry.registerAgent flips the Instance to `ready`. DELETE actually
 * tears the EC2 (+ SG + IAM) down via the SDK.
 *
 * Warm pool: for `kind: "ec2"`, POST first tries to claim
 *  a box the pool already booted (services/warmPoolClaim.ts). That answers
 * `{instance, claimed: true}` with the row already `ready`. Everything below is
 * the cold path, which every other request still takes and which now says
 * `claimed: false`. A user whose `box-image` flag names an image other than
 * the published one (services/boxImage.ts) never claims: pool boxes run the
 * published image.
 *
 * When box provisioning isn't configured (local dev, or a deploy that hasn't
 * surfaced the IAM-grant outputs into the secret yet), POST falls back to the
 * legacy manual-terraform path: it returns the raw token so the user can run
 * `terraform apply` themselves.
 *
 * External (self-managed) boxes: POST with { kind: "external" } skips AWS
 * entirely. It creates the Instance row + an instance-bound token and returns
 * the raw token (once) for the user to drop into agent.config.json on their own
 * machine (laptop, devbox, anything). Because the token is keyed by instanceId,
 * the agent gets its own registry slot — so one user can run several machines
 * at once, unlike a plain per-user token which only ever holds a single slot.
 */

import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { randomBytes, createHash } from 'crypto';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { provisionBox, terminateBox, isBoxProvisioningConfigured } from '../services/boxProvisioner';
import { PowerAction, powerRequestError } from '../services/boxPowerPolicy';
import { QUARANTINED, QUARANTINED_OWNER_ERROR, ownerBoxView } from '../services/boxQuarantinePolicy';
import { boxInUseFields } from '../services/boxActivity';
import { recordProductEvent } from '../services/productEvents';
import { boxEventDimensions } from '../services/boxPowerEvents';
import { PowerRequestConflict, requestPower } from '../services/boxPower';
import { lifecycleViewFor, recentAutoTerminations, setBoxLifecycle } from '../services/boxLifecycle';
import { HIBERNATE_OFF_CODE, HIBERNATE_OFF_ERROR } from '../services/boxPowerPolicy';
import { lifecycleSettingsError, parseLifecycleSettings } from '../services/boxLifecyclePolicy';
import { boolVariation } from '../services/featureFlags';
import { marksNewBoxForDotfiles, NEW_BOX_DOTFILES_FLAG } from '../services/newBoxDotfiles';
import { boxImageSelectionFor, isPublished, PUBLISHED_IMAGE } from '../services/boxImage';
import { boxSizeOptions, coveringPreset, decideBoxSize, instanceTypesForSize, isBoxSize, ownerDefaultSize, type BoxSize } from '../services/boxSize';
import { recordPoolClaim, warmPoolTargetFor } from '../services/warmPoolSizes';
import { repoSetupFor, repoSizesFor } from '../services/repoEnvironment';
import { prismaEnvironmentStore, resolveEnvironment, resolveStoredEnvironment, usableEnvironment, type EnvironmentRecord } from '../services/environments';
import { decideBoxDisk, defaultDiskGiB, diskOptions, DISK_ERROR } from '../services/boxDiskSize';
import { applyImageFloor, knownImageFloorGiB, type DiskNote } from '../services/boxImageFloor';
import { flavorOf, flavorSpec, type BoxFlavor } from '../services/boxFlavor';
import { parseRequirementsLabel, requirementsLabel, requirementsResolver, type BoxRequirements } from '../services/boxRequirements';
import type { InstanceTypeChoice } from '../services/boxProvisioner';
import type { EnvPoolMissReason } from '../services/envPoolClaim';
import { poolSpecHashOrNull, reconcileWarmPool } from '../services/warmPool';
import { instanceAgentTransport, isInstanceAgentConnected, sendToInstanceAgent } from '../services/agentRegistry';
import { describeRootVolume, diskView, growErrorMessage, growRefusal, growView, lastGrow, parseOwnerGrowBody, pendingRetry, reserveGrow, startGrow } from '../services/boxDisk';
import { revokeChats } from '../services/chatRevoke';
import {
  claimWarmBox,
  isNameConflict,
  prismaClaimEffects,
} from '../services/warmPoolClaim';
import { BOX_NAME_ERROR, isValidBoxName } from '../services/boxNames';
import { boxTokenName, checkBoxRename } from '../services/boxRename';
import { boxCreationRefusal, readBoxCreationFacts } from '../services/boxCreationGate';
import { RouteResult, sendResult } from './routeResult';
import { parseClaimTiming } from '../services/repoCreate';
import { notifyOnSuccess, notifyWorkspaceChange } from '../services/workspaceEvents';
import { resizeInfo, startResize, type ResizeActor } from '../services/boxResize';
import { resizeAccess, resizeInFlight, resizeView } from '../services/boxResizePolicy';
import { eventOpen, latestBoxEvent, latestBoxEvents } from '../services/boxEvents';
import { boxSetupRefusal, decideBoxSetup, isSetupOff, SETUP_OFF_FLAG } from '../services/boxSetup';
import { managedProjectsByBox, withManagedLabels } from '../services/spaceSlack/projectLabels';


function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return 'tmag_' + randomBytes(32).toString('hex');
}


/** A same-named box a new launch replaces: an EC2 box whose launch failed. */
function retiresOnRelaunch(existing: { kind: string; status: string }, kind: string): boolean {
  return kind === 'ec2' && existing.kind === 'ec2' && existing.status === 'failed';
}

/** Terminate a failed box; false when it left `failed` meanwhile. */
async function retireFailedBox(box: { id: string }): Promise<boolean> {
  const now = new Date();
  const { count } = await prisma.instance.updateMany({
    where: { id: box.id, status: 'failed' },
    data: { status: 'terminated', terminatedAt: now },
  });
  if (count === 0) return false;
  await prisma.agentToken.updateMany({ where: { instanceId: box.id, revokedAt: null }, data: { revokedAt: now } });
  if (isBoxProvisioningConfigured()) {
    const row = await prisma.instance.findUnique({ where: { id: box.id } });
    if (row) void terminateBox(row);
  }
  return true;
}

// Create a new box: row + per-instance agent token, atomically.
// The raw token is returned once.
//
// input.kind:
//   "ec2"      (default) — orchestrator-provisioned EC2 box (or the legacy
//                          manual-terraform fallback when AWS isn't wired).
//   "external"           — self-managed host; no AWS, token returned for the
//                          user to run the agent themselves.
//
// input.size: small, medium or large (services/boxSize.ts), for an ec2 box
// whose owner has box-default-size on; absent, the repo's .termag/environment.json
// or the default (decideBoxSize). input.repo: the GitHub repository the box
// is made for (a URL or owner/name), or a list of them for a multi-repo
// project, whose environment.json files are read (services/repoEnvironment.ts; the
// largest wins). A environment.json setting it can't use is left out, and the 201's
// `warnings` says why. input.environment: the name of an environment
// (services/environments.ts) the box is made for: its definition sizes the box
// instead (inline, or a pointer's file read from its branch now), and `repo`
// is not read. The order stays the size asked for, then the file, then the default.
//
// input.setupEnabled: false for a managed box termag sets nothing up on
// beyond managing it (services/boxSetup.ts), behind
// empty-box-enabled and never claimed from the warm pool: pool boxes have
// already run termag's setup. Absent, setup is on, unless input.useRepoSetup
// is true: then the repos' environment.json `setupEnabled` decides
// (repoSetupFor), and the 201's `repoSetup` says so, and whether it applied.
// Only a caller that states that setting sends useRepoSetup (the CLI); the
// UI shows no setup choice and never sends it, so a box made there has setup
// on whatever the repository says, and a repo's setting is never applied silently.
//
// input.diskGiB: the root disk, a whole number of GiB from 50 to 300
// (services/boxDiskSize.ts), for an ec2 box this orchestrator launches; absent,
// the repo files' resources.diskGiB or the default (BOX_ROOT_VOLUME_GB, 120).
// Not behind box-default-size. Any disk but the default launches cold: every
// warm-pool box has the default. A disk under the image's snapshot is raised
// to it (services/boxImageFloor.ts), and the 201's `disk` says so when it is
// (or that the floor isn't known yet) for a disk asked for.
//
// opts.parentInstanceId: the box whose own credentials asked for this one
// (the CLI on a box), recorded on the row whether it is claimed or launched.
// opts.relaunchSize, opts.relaunchDiskGiB: the size and disk of the failed
// box a Retry replaces, kept whatever the flag or the repo file says now, and
// opts.relaunchSetupOff that it had setup off, which empty-box-enabled does not gate. opts.createdFor: 'ask' for a box made for an
// ask (`termag ask --new-box`, the deprecated --for-ask), recorded by the
// CLI's create; it is sized like any other box.
/**
 * A repo's requirements as what a box launches at: EC2's match
 * (services/boxRequirements.ts), recorded as `4vcpu-32gib`; the preset it
 * starts with when it is one (which the warm pool can hold); else `fallback`,
 * the default, with a warning pushed onto `warnings`.
 */
async function meetRequirements(
  requirements: BoxRequirements, fallback: BoxSize | null, warnings: string[],
): Promise<{ size: BoxSize | null; matched: { label: string; types: InstanceTypeChoice } | null }> {
  const r = await requirementsResolver.resolve(requirements);
  if (!r.ok) {
    warnings.push(`${r.warning}; launching ${fallback ?? 'the configured type'} instead`);
    return { size: fallback, matched: null };
  }
  if (r.preset) return { size: r.preset, matched: null };
  return { size: null, matched: { label: requirementsLabel(requirements), types: r.choice } };
}

/** A 201's `warnings` (what of the repo's environment.json was left out), only when there are any. */
const warned = (warnings: string[]) => (warnings.length ? { warnings } : {});

export async function createBox(
  user: Express.User,
  input: { name?: unknown; kind?: unknown; size?: unknown; diskGiB?: unknown; repo?: unknown; flavor?: unknown; minimal?: unknown; setupEnabled?: unknown; useRepoSetup?: unknown; environment?: unknown },
  opts: CreateBoxOpts = {},
): Promise<RouteResult> {
  return notifyOnSuccess(await createBoxRow(user, input, opts), user.id, 'boxes');
}

interface CreateBoxOpts {
  requestHost?: string;
  parentInstanceId?: string | null;
  relaunchSize?: string | null;
  relaunchDiskGiB?: number | null;
  relaunchSetupOff?: boolean;
  createdFor?: string | null;
}

async function createBoxRow(
  user: Express.User,
  input: { name?: unknown; kind?: unknown; size?: unknown; diskGiB?: unknown; repo?: unknown; flavor?: unknown; minimal?: unknown; setupEnabled?: unknown; useRepoSetup?: unknown; environment?: unknown },
  opts: CreateBoxOpts,
): Promise<RouteResult> {
  const { name, kind: rawKind } = input;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { status: 400, body: { error: 'name required' } };
  }
  const kind = rawKind === 'external' ? 'external' : 'ec2';
  // Which flavor the box rides (services/boxFlavor.ts). The canonical field
  // is `flavor: 'minimal'` (the CLI's `--minimal`, POST /api/instances); a
  // 1.x-ish `minimal: true` means the same while it shows up. The spec's
  // three decisions ride with it: which image (a minimal request never reads
  // the box-image flag — it is per-user and chooses among full-bake images),
  // the disk fallback, and warm-pool eligibility. An external box runs on
  // hardware we never touch and always reads 'full'.
  const flavor: BoxFlavor = kind === 'ec2'
    ? (input.flavor !== undefined && input.flavor !== null ? flavorOf(input.flavor) : flavorOf(input.minimal))
    : 'full';
  const spec = flavorSpec(flavor);
  const trimmed = name.trim();
  if (!isValidBoxName(trimmed)) return { status: 400, body: { error: BOX_NAME_ERROR } };
  const repos = input.repo === undefined || input.repo === null ? []
    : typeof input.repo === 'string' ? [input.repo]
    : Array.isArray(input.repo) && input.repo.every(r => typeof r === 'string') ? input.repo as string[]
    : null;
  if (!repos) return { status: 400, body: { error: 'repo must be a string or a list of them', code: 'invalid_request' } };
  let environment: EnvironmentRecord | null = null;
  if (input.environment !== undefined && input.environment !== null && input.environment !== '') {
    const found = await usableEnvironment(prismaEnvironmentStore, input.environment, user.id);
    if (!('environment' in found)) return found;
    environment = found.environment;
  }

  // The size, decided before anything is written so a bad one costs nothing.
  // Only an orchestrator-launched box has one; the owner's box-default-size
  // must be on for any (decideBoxSize).
  const provisioned = kind === 'ec2' && isBoxProvisioningConfigured();
  const askedDisk = input.diskGiB !== undefined && input.diskGiB !== null;
  if (askedDisk && !provisioned) {
    return { status: 400, body: { error: 'Only a box this orchestrator launches has a disk size', code: 'invalid_disk' } };
  }
  if (askedDisk && !decideBoxDisk(input.diskGiB, null, 0).ok) return { status: 400, body: { error: DISK_ERROR, code: 'invalid_disk' } };
  // The disk, null for a box this orchestrator doesn't launch.
  let diskGiB = null as number | null;
  let size = null as BoxSize | null;
  // A repo's requirements (services/boxRequirements.ts) once matched: the row
  // records them as `4vcpu-32gib` and the launch walks their types. Null for
  // a preset, or when they fell back to `size`.
  let matched = null as { label: string; types: InstanceTypeChoice } | null;
  const sizeWarnings: string[] = [];
  // Whether the repos' environment.json was read for the size, its read warnings with it.
  let repoFileRead = false;
  const meet = async (requirements: BoxRequirements, fallback: BoxSize | null): Promise<void> => {
    ({ size, matched } = await meetRequirements(requirements, fallback, sizeWarnings));
  };
  const relaunchRequirements = parseRequirementsLabel(opts.relaunchSize);
  // A Retry's disk is the failed box's own, already decided (and maybe raised to the image's).
  const relaunchDisk = provisioned ? opts.relaunchDiskGiB ?? null : null;
  if (provisioned && isBoxSize(opts.relaunchSize)) {
    size = opts.relaunchSize;
    diskGiB = relaunchDisk ?? spec.defaultDiskGiB();
  } else if (provisioned && relaunchRequirements) {
    // Unmatched now, the replacement falls back to a preset that still covers them, never the owner's default (Bugbot, #985).
    await meet(relaunchRequirements, coveringPreset(relaunchRequirements));
    diskGiB = relaunchDisk ?? spec.defaultDiskGiB();
  } else if (provisioned) {
    const flagDefault = await ownerDefaultSize(user);
    // The repo file only matters for what isn't asked for: the size while sizes are on, and the disk; otherwise it isn't read.
    const asked = input.size !== undefined && input.size !== null && input.size !== '';
    const diskKnown = askedDisk || relaunchDisk != null;
    repoFileRead = (!asked && !!flagDefault) || !diskKnown;
    // An environment's one file stands in for its repositories'.
    const repoFile = !repoFileRead ? { sizes: null, warnings: [] }
      : environment ? await resolveStoredEnvironment(user.id, environment)
      : await repoSizesFor(user.id, repos);
    const sizing = decideBoxSize(input.size, repoFile.sizes, flagDefault);
    if (!sizing.ok) return { status: sizing.status, body: { error: sizing.error, code: sizing.code } };
    const disk = decideBoxDisk(input.diskGiB, repoFile.sizes, spec.defaultDiskGiB());
    if (!disk.ok) return { status: disk.status, body: { error: disk.error, code: disk.code } };
    diskGiB = relaunchDisk ?? disk.diskGiB;
    size = sizing.size;
    sizeWarnings.push(...repoFile.warnings);
    if (sizing.requirements) await meet(sizing.requirements, sizing.size);
    for (const w of sizeWarnings) console.warn(`[BOX] ${user.unixUsername}'s ${trimmed}: ${w}`);
  } else if (input.size !== undefined && input.size !== null && input.size !== '') {
    return { status: 400, body: { error: 'Only a box this orchestrator launches has a size', code: 'invalid_size' } };
  }

  // termag setup: as asked, else the repos' setupEnabled when the caller states it.
  // Read whenever it does, so the 201 can say a setting asked for overrode it.
  const repoSetup = kind === 'ec2' && provisioned && input.useRepoSetup === true
    && await boolVariation(SETUP_OFF_FLAG, user, false)
    ? await repoSetupFor(user.id, repos) : null;
  // The file's read warnings (GitHub failed, invalid JSON) come with the size when it was read;
  // otherwise from here, or the CLI applies setup on without saying setupEnabled went unread.
  if (repoSetup) sizeWarnings.push(...(repoFileRead ? [] : repoSetup.readWarnings), ...repoSetup.warnings);
  const decided = decideBoxSetup(input.setupEnabled, repoSetup);
  if ('error' in decided) return { status: 400, body: { error: decided.error, code: 'invalid_request' } };
  const setupEnabled = decided.setupEnabled;
  // What the CLI states: the repos turned setup off, and whether the box has it off.
  const setupNote = repoSetup?.setupEnabled === false ? { repoSetup: { setupEnabled: false, repos: repoSetup.repos, applied: decided.from === 'repo' } } : {};

  // Uniqueness per user. The DB has a unique index but we surface a 409
  // here rather than letting the user see a raw Prisma error.
  const existing = await prisma.instance.findFirst({
    where: { userId: user.id, name: trimmed, status: { not: 'terminated' } },
  });
  // A launch that failed is retried under its own name, so the failed box is
  // retired here rather than left behind beside its replacement.
  const retiring = existing && retiresOnRelaunch(existing, kind) ? existing : null;
  if (existing && !retiring) {
    return { status: 409, body: { error: `A box named "${trimmed}" already exists` } };
  }
  // Relaunching a failed box with setup off keeps it so, flag or not: the flag
  // gates turning setup off for a new box. That is a project's Retry
  // (opts.relaunchSetupOff), or a create of the failed box's own name, as New
  // project's Try again posts. Checked before anything is retired.
  const relaunchesSetupOff = !setupEnabled && (opts.relaunchSetupOff === true || (retiring !== null && isSetupOff(retiring)));
  const setupRefused = boxSetupRefusal(setupEnabled, kind, relaunchesSetupOff || (!setupEnabled && await boolVariation(SETUP_OFF_FLAG, user, false)));
  if (setupRefused) return setupRefused;
  // Projects waiting on it are moved to the new box by their own Retry
  // (relaunchBoxFor), which retires the box itself; retiring it here would
  // strand them on a terminated box.
  if (retiring && await prisma.project.count({ where: { instanceId: retiring.id, archived: false } }) > 0) {
    return { status: 409, body: { error: `"${trimmed}" failed to launch; use Retry on its project to launch it again` } };
  }

  if (kind === 'ec2') {
    const refusal = boxCreationRefusal(await readBoxCreationFacts(user));
    if (refusal) return refusal;
  }
  if (retiring && !await retireFailedBox(retiring)) {
    return { status: 409, body: { error: `A box named "${trimmed}" already exists` } };
  }

  try {
    // The owner's box-image flag, read once so the claim decision and the
    // launch agree. Pool boxes run the published image at the pool's size,
    // so a user whose flag or size says otherwise always takes the cold path. A flavor the
    // flagAware=false spec owns (minimal) spends no flag read: the
    // flag chooses among full-bake images, and its image is none of them.
    const image = provisioned && spec.flagAware ? await boxImageSelectionFor(user) : PUBLISHED_IMAGE;
    // The disk the box really gets: never under its image's snapshot (amiWithDisk), applied
    // here when that is known, so the row, the warm-pool check and the 201 say it (`disk`).
    // A pinned or channel image's floor is only known at launch, which records what the box got.
    let diskNote: { disk: DiskNote } | Record<string, never> = {};
    const floor = flavor === 'minimal' ? knownImageFloorGiB('box-min') : isPublished(image) ? knownImageFloorGiB('box') : null;
    if (diskGiB != null && relaunchDisk == null) {
      const floored = applyImageFloor(diskGiB, floor, askedDisk);
      diskGiB = floored.diskGiB;
      if (floored.note) diskNote = { disk: floored.note };
    }

    // An environment pool first (services/envPoolClaim.ts): a box made from a
    // pooled shared environment starts a stopped box with its setup already
    // run. Any miss, a capacity refusal in every zone included, goes on to the
    // warm pool and then cold, below.
    if (provisioned && environment && environment.visibility === 'shared'
      && setupEnabled && spec.warmPoolEligible && isPublished(image) && !matched
      && await (await import('../services/envPoolSizes')).envPoolTargetFor(environment.name) > 0) {
      // Loaded here, not at the top: only a pooled environment's create needs the pool's GitHub reader and claim.
      const { envPoolDefinitionByName } = await import('../services/envPool');
      const { claimEnvPoolBox, claimerCanRead, prismaEnvClaimEffects, recordEnvPoolClaim } = await import('../services/envPoolClaim');
      const { envPoolConfigFromEnv } = await import('../config/env');
      const env = environment;
      const pool = await envPoolDefinitionByName(env.name);
      const poolDisk = pool.ok ? applyImageFloor(pool.def.diskGiB, floor, false).diskGiB : null;
      const miss: EnvPoolMissReason | null = !pool.ok ? 'empty'
        : pool.def.size !== size || poolDisk !== diskGiB ? 'size'
        : !(await claimerCanRead(user.id, pool.def.repos.map(r => r.repo))) ? 'access-denied'
        : null;
      if (!pool.ok) console.warn(`[ENV-POOL] ${env.name}: no claim, the pool can't resolve it: ${pool.reason}`);
      if (miss || !pool.ok) {
        recordEnvPoolClaim({ user, environment: env.name, size, outcome: 'miss', reason: miss ?? 'empty' });
      } else {
        const startedAt = Date.now();
        const outcome = await claimEnvPoolBox(
          { owner: user, boxName: trimmed, environmentId: env.id, setupHash: pool.def.setupHash, parentInstanceId: opts.parentInstanceId ?? null },
          prismaEnvClaimEffects(envPoolConfigFromEnv(process.env).claimWaitMs),
        );
        if (outcome.claimed) {
          recordEnvPoolClaim({ user, environment: env.name, size, box: outcome.instance.id, outcome: 'hit', fallback: outcome.fallback, startMs: outcome.startMs, helloMs: outcome.helloMs, tried: outcome.tried });
          void import('../services/envPool').then(m => m.reconcileEnvPools());
          recordProductEvent('box.provisioned', { user: user.id, box: outcome.instance.id }, {
            ...boxEventDimensions(outcome.instance),
            boxKind: 'ec2', warmClaimed: true, pool: 'environment', environment: env.name, claimMs: Date.now() - startedAt, child: !!opts.parentInstanceId,
          });
          return { status: 201, body: { instance: outcome.instance, claimed: true, pool: 'environment', ...warned(sizeWarnings), ...setupNote, ...diskNote } };
        }
        recordEnvPoolClaim({ user, environment: env.name, size, outcome: 'miss', reason: outcome.reason, tried: outcome.tried });
      }
    }

    // The warm path, when there is a pool to ask and this user is in the
    // flag's audience. Anything else, including a drained pool and three
    // boxes whose agents will not answer, falls through to the cold path
    // below untouched.
    if (provisioned
      // termag setup off never claims one: pool boxes have run termag's setup.
      && setupEnabled
      // Pool boxes run the published full image; a flavor their spec keeps out of the pool never
      // claims one, whatever the owner's flags say.
      && spec.warmPoolEligible
      && isPublished(image)
      // A repo's requirements matched to a type of their own: the pool holds presets only.
      && !matched) {
      // The pool holds each size apart (services/warmPoolSizes.ts), so the
      // claim asks for the size this box launches at; a size it holds none
      // of, or none warm right now, is a miss that goes cold. Every pool box
      // has the default disk raised to the image's floor (amiWithDisk), so any
      // other disk goes cold without asking.
      const otherDisk = diskGiB !== applyImageFloor(defaultDiskGiB(), floor, false).diskGiB;
      const pooled = !otherDisk && await warmPoolTargetFor(size) > 0;
      const currentHash = pooled ? await poolSpecHashOrNull(size) : null;
      if (!currentHash) {
        const reason = otherDisk ? 'disk-not-pooled' : pooled ? 'no-warm-box' : 'size-not-pooled';
        recordPoolClaim({ user, size, via: 'add-box', outcome: 'miss', reason });
      } else {
        const startedAt = Date.now();
        const outcome = await claimWarmBox(
          { owner: user, boxName: trimmed, currentHash, size, parentInstanceId: opts.parentInstanceId ?? null },
          prismaClaimEffects,
        );
        if (outcome.claimed) {
          console.log(`[POOL] claim ${outcome.instance.id} by ${user.unixUsername} in ${Date.now() - startedAt}ms`);
          recordPoolClaim({ user, size, via: 'add-box', box: outcome.instance.id, outcome: 'hit' });
          // Un-awaited so the refill is under way before the browser has
          // rendered the row, and never on this request's critical path.
          void reconcileWarmPool();
          recordProductEvent('box.provisioned', { user: user.id, box: outcome.instance.id }, {
            ...boxEventDimensions(outcome.instance),
            boxKind: 'ec2', warmClaimed: true, pool: 'warm', environment: environment?.name ?? null, claimMs: Date.now() - startedAt, child: !!opts.parentInstanceId,
          });
          return { status: 201, body: { instance: outcome.instance, claimed: true, ...warned(sizeWarnings), ...setupNote, ...diskNote } };
        }
        console.log(`[POOL] claim fell through for ${user.unixUsername}: ${outcome.reason} after ${outcome.candidatesTried} candidate(s)`);
        recordPoolClaim({ user, size, via: 'add-box', outcome: 'miss', reason: outcome.reason });
      }
    }

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const tokenPrefix = rawToken.substring(0, 13) + '...';

    // Not with termag setup off: the on-claim run that applies them
    // needs the GitHub credentials such a box doesn't get, and would hold up its hello.
    const newBoxDotfiles = setupEnabled && marksNewBoxForDotfiles({
      kind, dotfilesRepoUrl: user.dotfilesRepoUrl,
      flagOn: kind === 'ec2' && !!user.dotfilesRepoUrl && await boolVariation(NEW_BOX_DOTFILES_FLAG, user, false),
    });
    const instance = await prisma.$transaction(async (tx) => {
      const created = await tx.instance.create({
        data: {
          userId: user.id,
          name: trimmed,
          kind,
          size: matched?.label ?? size,
          diskGiB,
          flavor,
          setupEnabled,
          parentInstanceId: opts.parentInstanceId ?? null,
          // External boxes have no provisioning step — they sit at
          // "awaiting-agent" until the self-run agent dials in and
          // registerAgent flips them to "ready".
          status: kind === 'external' ? 'awaiting-agent' : 'provisioning',
          // The owner's dotfiles, applied on the agent's first hello as a
          // warm claim does (services/newBoxDotfiles.ts).
          ...(newBoxDotfiles ? { onClaimStatus: 'pending' } : {}),
        },
      });
      await tx.agentToken.create({
        data: {
          userId: user.id,
          instanceId: created.id,
          name: boxTokenName(trimmed),
          tokenHash,
          tokenPrefix,
        },
      });
      return created;
    });

    // "Provisioned" as in asked for: the row exists and the launch is under
    // way (or, external, the owner's own agent is awaited). The ready
    // transition is the agent's hello, which the box telemetry covers.
    recordProductEvent('box.provisioned', { user: user.id, box: instance.id }, {
      boxKind: kind, warmClaimed: false, child: !!opts.parentInstanceId, setupEnabled, environment: environment?.name ?? null,
      provisioning: kind === 'external' ? 'external' : isBoxProvisioningConfigured() ? 'orchestrator' : 'manual',
    });

    if (kind === 'external') {
      // Self-managed host: no AWS work. Hand back the raw token (once) plus the
      // WS URL so the user can fill in agent.config.json on their own machine.
      const agentWsUrl = process.env.AGENT_WS_URL
        || `wss://${opts.requestHost ?? 'your-orchestrator'}/termag/ws/agent`;
      return {
        status: 201,
        body: {
          instance,
          claimed: false,
          token: rawToken,
          tokenPrefix,
          agentWsUrl,
          hint: 'Self-managed box. Put this token + termag_url into agent.config.json '
            + 'on your machine and start the termag agent. Shown once.',
        },
      };
    }

    if (isBoxProvisioningConfigured()) {
      // V2: provision the EC2 ourselves. Fire-and-forget — the box flips to
      // `ready` when its agent dials in, or `failed` on a provisioning error.
      // The raw token rides along in user_data, so it never leaves the server.
      void provisionBox({
        instance,
        boxName: trimmed,
        owner: user.googleEmail,
        token: rawToken,
        remoteUnixUser: user.unixUsername,
        gitUserEmail: user.googleEmail,
        gitUserName: user.displayName,
        flavor,
        image,
        instanceTypes: matched?.types ?? instanceTypesForSize(size),
        diskGiB,
      });
      return { status: 201, body: { instance, claimed: false, ...warned(sizeWarnings), ...setupNote, ...diskNote } };
    }

    // Legacy fallback: provisioning not configured. Return the raw token once
    // so the user can run `terraform apply` in terraform/box/ themselves.
    return {
      status: 201,
      body: {
        instance,
        claimed: false,
        token: rawToken,
        tokenPrefix,
        hint: 'Box provisioning is not configured; run `terraform apply` in terraform/box/ with this token',
      },
    };
  } catch (err) {
    // Defense-in-depth for the (userId, name) unique: the pre-check above
    // already 409s on an active duplicate, but a concurrent create could still
    // race into it, from the cold path's insert or from the claim's UPDATE.
    // Surface it as a clean 409 rather than letting it escape as an unhandled
    // rejection (which is what left the UI showing a generic "Failed to
    // create box" with no response).
    if (isNameConflict(err)) {
      return { status: 409, body: { error: `A box named "${trimmed}" already exists` } };
    }
    console.error('[BOX] create failed:', err instanceof Error ? err.message : String(err));
    return { status: 500, body: { error: 'Failed to create box' } };
  }
}

// Terminate a box: archive its projects, revoke its tokens, mark
// terminated, and (when provisioning is configured) actually destroy the
// EC2 + SG + IAM via the SDK. The teardown is fired un-awaited — it can take
// minutes for the instance to terminate before the SG can be deleted.
//
// If the box has live (non-archived) projects, returns 409 with the
// list. The client must re-send with `confirmed`.
export async function terminateOwnedBox(user: Express.User, id: string, confirmed: boolean): Promise<RouteResult> {
  // Its live projects are archived with it, so both lists change.
  return notifyOnSuccess(await terminateBoxRow(user, id, confirmed), user.id, ['boxes', 'projects']);
}

async function terminateBoxRow(user: Express.User, id: string, confirmed: boolean): Promise<RouteResult> {
  const instance = await prisma.instance.findFirst({
    where: { id, userId: user.id },
    include: {
      projects: {
        where: { archived: false },
        select: { id: true, name: true, kind: true, workstreams: { select: { id: true, name: true } } },
      },
    },
  });
  if (!instance) return { status: 404, body: { error: 'Box not found' } };
  if (instance.status === 'terminated') return { status: 200, body: { ok: true, alreadyTerminated: true } };
  // The lifecycle sweep, chat delete and the CLI all terminate through here.
  if (instance.status === QUARANTINED) return { status: 409, body: { error: QUARANTINED_OWNER_ERROR } };

  if (instance.projects.length > 0 && !confirmed) {
    return {
      status: 409,
      body: {
        error: 'Box has live projects',
        // All of them, a space orchestrator's labelled ("space orchestrator for <space>"): this is what the confirm names.
        projects: await withManagedLabels(instance.projects),
        hint: 'Re-send with body { "confirmed": true } to archive all projects and terminate the box',
      },
    };
  }

  // A host this request will not destroy (an external box, or one with no EC2
  // teardown) must not have its token revoked while a chat turn is still in
  // tmux: the socket closing does not kill that session. An EC2 terminate
  // while the agent is offline may proceed, because the instance is destroyed.
  if (instance.projects.length > 0) {
    const destroysHost = instance.kind !== 'external' && isBoxProvisioningConfigured();
    const connected = isInstanceAgentConnected(instance.id);
    for (const project of instance.projects) {
      const blocked = await revokeChats(
        (type, payload) => sendToInstanceAgent(instance.id, type, payload),
        connected,
        project.id,
        project.workstreams,
        { offlineBlocks: !destroysHost },
      );
      if (blocked) return { status: 409, body: { error: blocked } };
    }
  }

  await prisma.$transaction([
    prisma.project.updateMany({
      where: { instanceId: instance.id, archived: false },
      data: { archived: true },
    }),
    prisma.agentToken.updateMany({
      where: { instanceId: instance.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.instance.update({
      where: { id: instance.id },
      data: { status: 'terminated', terminatedAt: new Date() },
    }),
  ]);

  if (instance.kind === 'external') {
    // Self-managed host: no AWS to tear down. The token is already revoked
    // above, which disconnects the agent; the user stops it on their machine.
    return {
      status: 200,
      body: {
        ok: true,
        archivedProjects: instance.projects.length,
        hint: 'Token revoked. Stop the termag agent on this machine (it will keep retrying otherwise).',
      },
    };
  }

  if (isBoxProvisioningConfigured()) {
    // Tear down the EC2 + SG + IAM. Fire-and-forget; cleanup is idempotent
    // and tolerates a partially-provisioned box.
    void terminateBox(instance);
    return { status: 200, body: { ok: true, archivedProjects: instance.projects.length } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      archivedProjects: instance.projects.length,
      hint: 'Run `terraform destroy` in terraform/box/ to remove the EC2',
    },
  };
}

// Stop or start the box's EC2 instance. Answers 202 with the transitional
// status; the power sweep settles `stopping` to `stopped`, and the agent's
// connect settles `starting` to `ready`.
export async function powerOwnedBox(user: Express.User, id: string, action: PowerAction): Promise<RouteResult> {
  return notifyOnSuccess(await powerBoxRow(user, id, action), user.id, 'boxes');
}

async function powerBoxRow(user: Express.User, id: string, action: PowerAction): Promise<RouteResult> {
  const instance = await prisma.instance.findUnique({ where: { id } });
  const refused = powerRequestError(instance, user.id, action, isBoxProvisioningConfigured());
  if (refused) return { status: refused.status, body: { error: refused.error } };
  // Nothing hibernates a box, a person included. A start still resumes one
  // already hibernated.
  if (action === 'hibernate') {
    return { status: 409, body: { error: HIBERNATE_OFF_ERROR, code: HIBERNATE_OFF_CODE } };
  }
  try {
    const status = await requestPower(instance!, action, { markInUse: action === 'start', byOwner: true });
    return { status: 202, body: { ok: true, status } };
  } catch (err) {
    if (err instanceof PowerRequestConflict) return { status: 409, body: { error: err.message } };
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[BOX] ${action} ${instance!.name} failed:`, message);
    return { status: 502, body: { error: `EC2 refused the ${action}: ${message}` } };
  }
}

// Change a box's automatic lifecycle settings.
// Owner only; another user's box answers 404 like a missing one. Answers the
// settings as stored; a box that can't hibernate takes them too, and the
// answer's `lifecycle.warning` says auto-park will do nothing there.
export async function setOwnedBoxLifecycle(user: Express.User, id: string, body: unknown): Promise<RouteResult> {
  const parsed = parseLifecycleSettings(body);
  if ('error' in parsed) return { status: 400, body: { error: parsed.error } };
  const instance = await prisma.instance.findFirst({ where: { id, userId: user.id } });
  if (!instance) return { status: 404, body: { error: 'Box not found' } };
  const refused = lifecycleSettingsError(instance, parsed.settings);
  if (refused) return { status: 409, body: { error: refused } };
  await setBoxLifecycle(instance.id, parsed.settings);
  const row = await prisma.instance.findUniqueOrThrow({ where: { id: instance.id } });
  return { status: 200, body: { lifecycle: await lifecycleViewFor(user, row) } };
}

// Keep a box running: its owner is using it, so
// the idle clock restarts and a standing warning goes stale, as a keystroke
// would make it. Owner only; another user's box answers 404 like a missing
// one, and only a ready box can be kept (409 otherwise). `via` is where the
// owner pressed it, for the box.kept_running product event.
export async function keepOwnedBoxRunning(user: Express.User, id: string, via: 'ui' | 'cli' | 'slack'): Promise<RouteResult> {
  const instance = await prisma.instance.findFirst({ where: { id, userId: user.id } });
  if (!instance) return { status: 404, body: { error: 'Box not found' } };
  const notRunning = { status: 409, body: { error: `Only a running box can be kept running; ${instance.name} is ${instance.status}` } };
  if (instance.status !== 'ready') return notRunning;
  const kept = await prisma.instance.updateMany({ where: { id, status: 'ready' }, data: boxInUseFields(id) });
  if (kept.count === 0) return notRunning;
  recordProductEvent('box.kept_running', { user: user.id, box: id }, { via });
  // Kept from Slack or the CLI, the owner's open tabs drop the countdown too (Bugbot on #621).
  notifyWorkspaceChange(user.id, 'boxes');
  console.log(`[LIFECYCLE] ${instance.name} (${user.unixUsername}): kept running by the owner (${via})`);
  const row = await prisma.instance.findUniqueOrThrow({ where: { id } });
  return { status: 200, body: { lifecycle: await lifecycleViewFor(user, row) } };
}

// Rename a box (services/boxRename.ts). Owner only; another user's box answers
// 404 like a missing one. Its agent token's label follows when it still
// carries the old name. Project lists show box names, so both lists change.
export async function renameOwnedBox(user: Express.User, id: string, newName: unknown): Promise<RouteResult> {
  return notifyOnSuccess(await renameBoxRow(user, id, newName), user.id, ['boxes', 'projects']);
}

async function renameBoxRow(user: Express.User, id: string, newName: unknown): Promise<RouteResult> {
  const instance = await prisma.instance.findFirst({ where: { id, userId: user.id } });
  if (instance?.status === QUARANTINED) return { status: 409, body: { error: QUARANTINED_OWNER_ERROR } };
  const check = checkBoxRename(instance, newName);
  if (!check.ok) return { status: check.status, body: { error: check.error } };
  if (check.unchanged) return { status: 200, body: { instance } };

  const conflict = { status: 409, body: { error: `A box named "${check.name}" already exists` } };
  const taken = await prisma.instance.findFirst({
    where: { userId: user.id, name: check.name, status: { not: 'terminated' }, id: { not: id } },
    select: { id: true },
  });
  if (taken) return conflict;

  try {
    const [renamed] = await prisma.$transaction([
      prisma.instance.update({ where: { id }, data: { name: check.name } }),
      prisma.agentToken.updateMany({
        where: { instanceId: id, name: boxTokenName(instance!.name) },
        data: { name: boxTokenName(check.name) },
      }),
    ]);
    console.log(`[BOX] ${user.unixUsername} renamed box ${id} from "${instance!.name}" to "${check.name}"`);
    return { status: 200, body: { instance: renamed } };
  } catch (err) {
    if (isNameConflict(err)) return conflict;
    throw err;
  }
}

// Resize a box to another size (services/boxResize.ts). Owner only here;
// another user's box answers 404 like a missing one, and an admin resizes
// anyone's from the Fleet tab (routes/admin/resize.ts). `force` confirms
// stopping what is running on it (a turn, an SSH session); 202 with the
// resize as it starts, whose phases follow on the status socket.
export async function resizeOwnedBox(user: Express.User, id: string, body: unknown, via: ResizeActor['via']): Promise<RouteResult> {
  const instance = await prisma.instance.findUnique({ where: { id } });
  const denied = resizeAccess(instance, { id: user.id, isAdmin: false }, 'owner');
  if (denied) return { status: denied.status, body: { error: denied.error, code: denied.code } };
  const { size, force } = (body ?? {}) as { size?: unknown; force?: unknown };
  const started = await startResize(instance!, size, { userId: user.id, role: 'owner', via }, { force: force === true });
  return started.ok ? { status: 202, body: { resize: started.resize } } : { status: started.status, body: started.body };
}

// Grow the caller's own box's disk (services/boxDisk.ts): the admin Grow
// disk's checks and box_events row, as the owner (no reason), up to
// OWNER_MAX_GB, grow only. Another user's box is 404 like a missing one. EBS's
// one change per six hours is refused before EC2 is asked (409
// disk_cooldown), and EC2's own refusal says the same. The box stays up; a
// resize asked for next waits for the grow before it stops the box.
export async function growOwnedBox(user: Express.User, id: string, body: unknown, via: 'ui' | 'cli'): Promise<RouteResult> {
  const instance = await prisma.instance.findUnique({ where: { id } });
  if (!instance || instance.userId !== user.id || instance.status === 'terminated') {
    return { status: 404, body: { error: 'Box not found', code: 'not_found' } };
  }
  const refusal = growRefusal(instance, instanceAgentTransport(id)?.capabilities ?? null);
  if (refusal) return { status: 409, body: { error: refusal, code: 'disk_unavailable' } };
  // Held as growing from here (boxDisk.reserveGrow), before the resize check and the awaits after it: a
  // resize asked in between waits for this grow instead of stopping the box under it (Devin on #1214).
  const release = reserveGrow(id);
  try {
    if (resizeInFlight(await latestBoxEvent(id, 'resize'))) {
      return { status: 409, body: { error: 'The box is being resized; grow its disk once that is done', code: 'resize_running' } };
    }
    // A grow another orchestrator process runs is only its open, fresh row: never a second beside it (Cursor on #1214).
    // This process's own finished grow, whose row is still being closed, is not one of those.
    const lastGrowRow = await latestBoxEvent(id, 'disk-grow');
    if (lastGrowRow && eventOpen(lastGrowRow) && lastGrow(id)?.eventId !== lastGrowRow.id) {
      return { status: 409, body: { error: 'a grow is already running on this box', code: 'disk_unavailable' } };
    }
    let volume;
    try {
      volume = await describeRootVolume(instance);
    } catch (err) {
      return { status: 503, body: { error: `Could not read the disk: ${(err as Error).message}`, code: 'disk_unreadable' } };
    }
    const parsed = parseOwnerGrowBody(body, volume);
    if ('error' in parsed) return { status: parsed.code === 'invalid_disk' ? 400 : 409, body: { error: parsed.error, code: parsed.code } };
    const modifies = parsed.sizeGb > volume.sizeGb;
    // The size the volume already has changes nothing, and is answered as such: no grow, no box_events row, no
    // ModifyVolume and no activity, however often it is asked. The one exception is a grow that failed or was cut
    // off at that size, whose file system step it runs again (the dialogs' "Finish growing the disk"), still
    // without touching the idle clock.
    if (!modifies && !pendingRetry(id, parsed.sizeGb, lastGrowRow)) {
      return { status: 200, body: { grow: null, alreadyGb: volume.sizeGb, message: `The disk is already ${volume.sizeGb} GB` } };
    }
    // A grow that modifies the volume is the owner using the box. The idle clock restarts before the grow does, in
    // a write guarded on the box still being ready and on the clock this request read, so an idle sweep that read
    // the clock earlier can't stop the box mid-grow (its own stop is guarded on the clock it read, boxLifecycle).
    // Activity written during this request's awaits makes the claim miss, and it reads the box again (a few times
    // at most); `before` is the snapshot the claim matched. If EC2 refuses the modification, the clock goes back to
    // `before`, so only an accepted grow counts as activity. While any grow runs, retries included, the idle sweep's
    // `disk-grow` busy check holds the box (services/boxDiskBusy.ts).
    let claimed: Date | null = null;
    let before: Pick<typeof instance, 'lastActivityAt' | 'parkedAt' | 'autoParkedAt' | 'lifecycleNote'> = instance;
    if (modifies) {
      let snap: typeof instance | null = instance;
      for (let attempt = 0; attempt < 3 && snap && snap.status === 'ready' && !claimed; attempt++) {
        const inUse = boxInUseFields(id);
        const took = await prisma.instance.updateMany({ where: { id, status: 'ready', lastActivityAt: snap.lastActivityAt }, data: inUse });
        if (took.count === 1) {
          claimed = inUse.lastActivityAt;
          before = { lastActivityAt: snap.lastActivityAt, parkedAt: snap.parkedAt, autoParkedAt: snap.autoParkedAt, lifecycleNote: snap.lifecycleNote };
        } else {
          snap = await prisma.instance.findUnique({ where: { id } });
        }
      }
      if (!claimed) return { status: 409, body: { error: 'The box changed while the grow was being asked for; reload and try again', code: 'box_changing' } };
    }
    try {
      const grow = await startGrow(instance, volume, parsed.sizeGb, user.unixUsername, undefined, user.id, 'owner');
      console.log(`[BOX-DISK] ${user.unixUsername} grows ${instance.name} to ${parsed.sizeGb} GB (via ${via})`);
      return { status: 202, body: { grow: growView(grow) } };
    } catch (err) {
      if (claimed) {
        await prisma.instance.updateMany({
          where: { id, lastActivityAt: claimed },
          data: { lastActivityAt: before.lastActivityAt, parkedAt: before.parkedAt, autoParkedAt: before.autoParkedAt, lifecycleNote: before.lifecycleNote },
        }).catch(e => console.error(`[BOX-DISK] ${instance.name}: idle clock restore failed:`, (e as Error).message));
      }
      const error = growErrorMessage(err);
      return { status: 409, body: { error, code: error.startsWith('EBS allows one change') ? 'disk_cooldown' : 'disk_refused' } };
    }
  } finally {
    // startGrow has registered the grow by now when it went through, so the box stays held.
    release();
  }
}

/** `?repo=` once per repository: a multi-repo project's box takes the largest. */
export function repoQuery(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value])
    .filter((r): r is string => typeof r === 'string' && !!r.trim()).map(r => r.trim());
}

/**
 * The New box pickers' sizes for a box for `repos` (GET /api/instances/sizes,
 * and the CLI's GET /boxes/sizes): every size, and the one to preselect.
 * `environmentName`: a box made from that environment instead, sized by its
 * one file, as createBox does.
 */
export async function boxSizeChoices(user: Express.User, repos: string[], environmentName?: string | null): Promise<RouteResult> {
  let environment: EnvironmentRecord | null = null;
  if (environmentName?.trim()) {
    const found = await resolveEnvironment(prismaEnvironmentStore, environmentName, user.id);
    if (!('environment' in found)) return found;
    environment = found.environment;
  }
  const provisioned = isBoxProvisioningConfigured();
  const flagDefault = provisioned ? await ownerDefaultSize(user) : null;
  // Read for the disk too, which no flag gates.
  const repoFile = !provisioned ? { sizes: null, warnings: [] }
    : environment ? await resolveStoredEnvironment(user.id, environment)
    : repos.length ? await repoSizesFor(user.id, repos) : { sizes: null, warnings: [] };
  const sizing = decideBoxSize(undefined, repoFile.sizes, flagDefault);
  const warnings = [...repoFile.warnings];
  let defaultSize = sizing.ok ? sizing.size : null;
  // The repo's minimums as EC2 matched them: the pickers' preselected entry, named by its type (r8g.xlarge).
  let defaultRequirements: (BoxRequirements & { instanceType: string }) | null = null;
  if (sizing.ok && sizing.requirements) {
    const met = await meetRequirements(sizing.requirements, sizing.size, warnings);
    // Matched, defaultSize stays the preset they'd fall back to, for a client without the repo entry.
    if (met.matched) defaultRequirements = { ...sizing.requirements, instanceType: met.matched.types.type };
    else defaultSize = met.size;
  }
  return {
    status: 200,
    body: {
      ...boxSizeOptions(flagDefault),
      defaultSize,
      defaultSource: sizing.ok ? sizing.source : null,
      defaultRequirements,
      warnings,
      // The disk field's range and preselection (services/boxDiskSize.ts); null where no box is launched here.
      disk: provisioned ? diskOptions(defaultDiskGiB(), repoFile.sizes) : null,
    },
  };
}

/** What the Size… pickers show for the caller's own box (services/boxResize.ts resizeInfo). */
export async function ownedBoxResizeInfo(user: Express.User, id: string): Promise<RouteResult> {
  const instance = await prisma.instance.findUnique({ where: { id } });
  const denied = resizeAccess(instance, { id: user.id, isAdmin: false }, 'owner');
  if (denied) return { status: denied.status, body: { error: denied.error, code: denied.code } };
  // The disk beside the size (services/boxDisk.ts): the owner's dialogs grow it in the same go.
  const disk = instance!.kind === 'ec2' && instance!.ec2InstanceId
    ? diskView(instance!, instanceAgentTransport(id)?.capabilities ?? null,
      await describeRootVolume(instance!).catch((err: Error) => ({ error: err.message })), Date.now(),
      // The last grow's row: its retry survives an orchestrator restart that lost the grow in memory.
      await latestBoxEvent(id, 'disk-grow'))
    : null;
  return { status: 200, body: { ...await resizeInfo(instance!), disk } };
}

export function instancesRouter(): Router {
  const router = Router();

  // List the caller's non-terminated boxes, including project counts.
  const list: RequestHandler = async (req, res) => {
    const instances = await prisma.instance.findMany({
      where: { userId: req.user!.id, status: { not: 'terminated' } },
      include: { _count: { select: { projects: true } } },
      orderBy: { createdAt: 'desc' },
    });
    // Each box's current or last resize, from box_events (services/boxEvents.ts).
    const resizes = await latestBoxEvents(instances.map(i => i.id), 'resize');
    const managed = await managedProjectsByBox(instances.map(i => i.id));
    res.json(await Promise.all(instances.map(async i => ({
      ...ownerBoxView(i), lifecycle: await lifecycleViewFor(req.user!, i), resize: resizeView(resizes.get(i.id)),
      // What the Stop warning names beside its count: a space orchestrator is never hidden there (projectKind.ts inProjectLists).
      managedProjects: managed.get(i.id) ?? [],
    }))));
  };

  // Single box. Includes project list (id+name only) for the delete-confirm UI.
  const getOne: RequestHandler = async (req, res) => {
    const instance = await prisma.instance.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: {
        // Every live project, a space orchestrator's included and labelled: the
        // delete confirmation names them all (projectKind.ts inProjectLists).
        projects: {
          where: { archived: false },
          select: { id: true, name: true, kind: true },
          orderBy: { name: 'asc' },
        },
      },
    });
    if (!instance) { res.status(404).json({ error: 'Box not found' }); return; }
    res.json(ownerBoxView({ ...instance, projects: await withManagedLabels(instance.projects) }));
  };

  const create: RequestHandler = async (req, res) => {
    sendResult(res, await createBox(req.user!, req.body ?? {}, { requestHost: req.get('host') }));
  };

  // The browser's own measure of a claim: click to first terminal data, which
  // is the number WC-3's p95 is taken over. Logged rather than stored, because
  // there is no column for it and this PR carries no migration; the samples
  // come back out of the [POOL] log.
  const claimTiming: RequestHandler = async (req, res) => {
    const parsed = parseClaimTiming(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const instance = await prisma.instance.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { id: true },
    });
    if (!instance) { res.status(404).json({ error: 'Box not found' }); return; }

    const pick = parsed.pickMs === null ? '' : ` pick ${Math.round(parsed.pickMs)}ms`;
    console.log(`[POOL] claim-timing ${instance.id} ${Math.round(parsed.ms)}ms${pick}`);
    res.json({ ok: true });
  };

  const dismissRepoPrompt: RequestHandler = async (req, res) => {
    const existing = await prisma.instance.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!existing) { res.status(404).json({ error: 'Box not found' }); return; }
    if (existing.kind !== 'ec2') {
      res.status(400).json({ error: 'Only a managed box can dismiss the repository prompt' });
      return;
    }
    await prisma.instance.updateMany({
      where: { id: existing.id, userId: req.user!.id, repoPromptDismissedAt: null },
      data: { repoPromptDismissedAt: new Date() },
    });
    const instance = await prisma.instance.findFirst({
      where: { id: existing.id, userId: req.user!.id },
    });
    if (!instance) { res.status(404).json({ error: 'Box not found' }); return; }
    res.json(ownerBoxView(instance));
  };

  const onClaimLog: RequestHandler = async (req, res) => {
    const instance = await prisma.instance.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { id: true, hostHome: true },
    });
    if (!instance) { res.status(404).json({ error: 'Box not found' }); return; }
    try {
      const home = instance.hostHome ?? '/home/termag';
      const reply = await sendToInstanceAgent(
        instance.id,
        'read-file',
        { path: `${home}/.termag/on-claim.log` },
      );
      const content = typeof reply?.content === 'string' ? reply.content.slice(-16 * 1024) : '';
      res.json({ log: content });
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Box agent unavailable' });
    }
  };

  const terminate: RequestHandler = async (req, res) => {
    const confirmed = (req.body as { confirmed?: boolean })?.confirmed === true;
    sendResult(res, await terminateOwnedBox(req.user!, req.params.id, confirmed));
  };

  // Stop, hibernate or start the box's EC2 instance. Answers 202 with the
  // transitional status; the power sweep settles `stopping` to `stopped` and
  // `hibernating` to `hibernated`, and the agent's connect settles `starting`
  // to `ready`. A hibernate EC2 refuses answers `stopping`: it fell back to a
  // plain stop, and the row's provisioningError says so.
  const power = (action: PowerAction): RequestHandler => async (req, res) => {
    sendResult(res, await powerOwnedBox(req.user!, req.params.id, action));
  };

  // asyncHandler: Express 4 drops async rejections on the floor, so a DB error
  // in any of these would otherwise hang the request until the proxy's timeout
  // (that was the 504 on POST before #59 added create's own try/catch). With
  // the wrapper they reach apiErrorHandler and answer with JSON.
  router.get('/', requireAuth, asyncHandler(list));
  // Boxes the lifecycle sweep terminated in the last week; terminated boxes
  // are otherwise left out of the list. Before /:id so it isn't taken as one.
  router.get('/auto-terminated', requireAuth, asyncHandler(async (req, res) => {
    res.json(await recentAutoTerminations(req.user!.id));
  }));
  // The New box pickers' sizes (services/boxSize.ts): `enabled: false` while
  // the owner's box-default-size is off, which is also when POST refuses one.
  // `defaultSize` is what a POST with no size would launch at for `?repo=`
  // (decideBoxSize: the repo's .termag/environment.json, else the owner's default),
  // which the dropdowns preselect, or `defaultRequirements` when the file's
  // minimums matched a type of their own; `warnings` what of that file was
  // left out. `disk`, whatever the size flag says: the New box disk field's
  // range, the default, and what a box for `?repo=` gets.
  router.get('/sizes', requireAuth, asyncHandler(async (req, res) => {
    // ?environment=: a box made from that environment is sized by its one file, as POST does.
    const environment = typeof req.query.environment === 'string' ? req.query.environment : null;
    sendResult(res, await boxSizeChoices(req.user!, repoQuery(req.query.repo), environment));
  }));
  router.get('/:id', requireAuth, asyncHandler(getOne));
  router.post('/', requireAuth, asyncHandler(create));
  router.post('/:id/claim-timing', requireAuth, asyncHandler(claimTiming));
  router.post('/:id/repo-prompt-dismiss', requireAuth, asyncHandler(dismissRepoPrompt));
  router.get('/:id/on-claim-log', requireAuth, asyncHandler(onClaimLog));
  router.delete('/:id', requireAuth, asyncHandler(terminate));
  router.post('/:id/stop', requireAuth, asyncHandler(power('stop')));
  router.post('/:id/start', requireAuth, asyncHandler(power('start')));
  router.post('/:id/hibernate', requireAuth, asyncHandler(power('hibernate')));
  router.post('/:id/rename', requireAuth, asyncHandler(async (req, res) => {
    sendResult(res, await renameOwnedBox(req.user!, req.params.id, req.body?.name));
  }));
  router.patch('/:id/lifecycle', requireAuth, asyncHandler(async (req, res) => {
    sendResult(res, await setOwnedBoxLifecycle(req.user!, req.params.id, req.body));
  }));
  router.post('/:id/keep-running', requireAuth, asyncHandler(async (req, res) => {
    sendResult(res, await keepOwnedBoxRunning(req.user!, req.params.id, 'ui'));
  }));
  router.get('/:id/resize', requireAuth, asyncHandler(async (req, res) => {
    sendResult(res, await ownedBoxResizeInfo(req.user!, req.params.id));
  }));
  router.post('/:id/disk', requireAuth, asyncHandler(async (req, res) => {
    sendResult(res, await growOwnedBox(req.user!, req.params.id, req.body, 'ui'));
  }));
  router.post('/:id/resize', requireAuth, asyncHandler(async (req, res) => {
    sendResult(res, await resizeOwnedBox(req.user!, req.params.id, req.body, 'ui'));
  }));

  return router;
}
