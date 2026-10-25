/**
 * POST /internal/claude-runner/spawn — start a one-shot Claude Code self-hosted
 * runner on the session owner's box.
 *
 * Caller: deploy/claude-spawn-runner, run by the Claude Code orchestrator
 * on this host, against the backend's own port (the nginx gateway 404s every
 * /termag/internal/ path, deliberately). Trust: loopback peer (isLocalPeer,
 * same as status writes) AND a bearer token cloud-init
 * generates under /srv/termag/secrets and hands to both sides. Mounted only
 * when CLAUDE_RUNNER_SPAWN_TOKEN is set, so a host without the orchestrator
 * 404s the path.
 *
 * Responses map onto the hook's exit-code contract:
 *   202  started (or 200: this order is already running; idempotent on orderId)
 *   400  malformed body                         -> hook exit 2 (non-retryable)
 *   404  email is not a termag user (and, behind claude-runner-auto-user-enabled with
 *        claude-runner-auto-box-enabled, could not be made one) -> hook exit 2; the body carries
 *        code OWNER_NOT_FOUND so the hook can tell it from an unmounted route
 *        (a plain 404, retried like a 401: configuration, not the session)
 *   Every 503 and 502 body carries `code`, one of REFUSAL_CODES in
 *   services/claudeRunnerSpawn.ts, beside the `error` text the hook relays;
 *   the hook ignores it, the event log and the owner's view key on it.
 *   503  owner has not connected GitHub (broker hosts; advisory behind
 *        claude-runner-anthropic-git-enabled on a box whose wrapper can run
 *        Anthropic-managed git), has no ready box whose agent can run a
 *        runner (behind the claude-runner-auto-box-enabled flag the route
 *        first starts, claims or provisions one), every such box already
 *        runs MAX_RUNNERS_PER_BOX sessions, or this process is draining for
 *        a deploy (its box agents are leaving)   -> hook exit 1 (retryable)
 *   502  a box agent failed an RPC             -> hook exit 1
 *
 * Every outcome is logged once, as `[CLAUDE-RUNNER] order <id> for
 * <unixUsername> ...`: once the termag.service journal is shipped to a log
 * store, who starts sessions and how often they are refused is
 * a query over these lines. The owner's username, never the email; the hook's
 * own stderr names neither, since it lands in the session's Activity tab.
 *
 * Each session gets a slot (DEV_INSTANCE 2..) that names its checkout and tmux
 * session on the box. The runner is that session's only process, so the box's
 * live tmux sessions are the truth about which slots are taken, after a
 * backend restart too (services/claudeRunnerSpawn.ts).
 */
import { Router, RequestHandler } from 'express';
import type { Instance, User } from '@prisma/client';
import { prisma } from '../db';
import { isLocalPeer } from '../auth/peerAddress';
import { asyncHandler } from '../middleware/errors';
import { instanceAgentTransport, isInstanceAgentConnected, sendToInstanceAgent } from '../services/agentRegistry';
import { getCredentialStoreConfig, githubStoreDeps } from '../services/credentialStore';
import { getGithubBrokerUrl } from '../services/githubBroker';
import { findUserByEmail } from '../services/userByEmail';
import { otlpDestinationFromEnv } from '../config/env';
import { discardRunnerStart, recordRunnerStart } from '../services/claudeRunnerSessions';
import { recordSessionEvent, type SessionEventKind } from '../services/claudeSessionEvents';
import { recordProductEvent } from '../services/productEvents';
import { boolVariation } from '../services/featureFlags';
import { isBoxProvisioningConfigured, isConcurrentCreate, pickFreeBoxName, provisionNewBox } from '../services/boxProvisioner';
import { boxImageSelectionFor, isPublished } from '../services/boxImage';
import { ownerHibernationEnabled, poolHibernationEnabled } from '../services/boxHibernationFlag';
import { boxCreationRefusal, readBoxCreationFacts } from '../services/boxCreationGate';
import { PowerRequestConflict, requestPower } from '../services/boxPower';
import { powerRequestError } from '../services/boxPowerPolicy';
import { claimWarmBox, isNameConflict, prismaClaimEffects, WARM_POOL_ENABLED_FLAG } from '../services/warmPoolClaim';
import { poolSpecHashOrNull, reconcileWarmPool } from '../services/warmPool';
import { deliveryInFlight } from '../services/credentialDelivery';
import { parseAllowedUsers, resolveUnixUsername } from '../auth/allowedUsers';
import { createOwnerFromAllowlist, flagIdentity, pendingOwnerContext, slackRealName } from '../services/claudeRunnerOwner';
import { notifyGithubAbsent, notifyRefusal } from '../services/claudeRunnerNotices';
import type { RefusalCode } from '../services/claudeRunnerSpawn';
import {
  CLAUDE_RUNNER_ANTHROPIC_GIT_FLAG,
  CLAUDE_RUNNER_AUTO_BOX_FLAG,
  CLAUDE_RUNNER_AUTO_USER_FLAG,
  type GithubLaunchState,
  MAX_RUNNERS_PER_BOX,
  type RunnerGitOptions,
  WRAPPER_FLAGS_CAPABILITY,
  type OwnedBox,
  REFUSAL,
  type Refusal,
  RUNNER_AGENT_CAPABILITY,
  autoBoxName,
  autoBoxPlan,
  bearerToken,
  githubGate,
  refusalStatus,
  type CandidateBox,
  ownerPlacementKey,
  parseRunnerSessions,
  parseSpawnBody,
  placeRunner,
  runnerBoxes,
  runnerLaunch,
  serializeByKey,
  tokensEqual,
} from '../services/claudeRunnerSpawn';

/** How long the spawn waits for Slack to name a first-time owner before settling for the email's local part. */
export const SLACK_NAME_BUDGET_MS = 3_000;

/** In the 404 body for an owner who is not a termag user; deploy/claude-spawn-runner matches it. */
export const OWNER_NOT_FOUND = 'owner-not-found';

type Outcome = { status: number; body: Record<string, unknown> };
/** A refusal as an outcome: its status, and a body the hook relays (`error`) and the event log keys on (`code`). */
const refused = (r: Refusal): Outcome => ({ status: refusalStatus(r), body: { error: r.text, code: r.code } });

/**
 * Behind CLAUDE_RUNNER_AUTO_BOX_FLAG, for an owner with no box a runner can
 * use: wait for one on its
 * way, start a stopped one, or get a new one (a warm-pool claim, else a cold
 * box), unless one failed within the hour. Runs under the owner's spawn lock,
 * so the next session of a burst sees this one's box and waits. Always 503:
 * the session is retried once the box's agent connects. Nothing billable
 * starts once the hook has stopped waiting (`callerGone`, like the placement
 * path before a launch): the session is re-offered and the next attempt
 * decides again, so a session cancelled in between buys no box.
 */
/**
 * How long a spawn may spend before it must answer: the hook's curl waits 20
 * seconds (deploy/claude-spawn-runner, --max-time), and a 503 after that is
 * a 503 nobody reads. A placement on a box claimed in this request (B2) waits
 * for the claim's credential delivery only inside what is left of this.
 */
export const PLACEMENT_BUDGET_MS = 15_000;

/**
 * Wait for the delivery still running to a box, if any, up to `ms`. True when
 * there is none or it settled (however it ended: its starter logs failures,
 * and the runner's own credential steps are best effort); false when it is still
 * running at the deadline.
 */
async function deliverySettled(instanceId: string, ms: number): Promise<boolean> {
  const running = deliveryInFlight(instanceId);
  if (!running) return true;
  if (ms <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const done = running.then(() => true, () => true);
  const late = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  try { return await Promise.race([done, late]); } finally { clearTimeout(timer); }
}

async function getOwnerABox(
  user: User,
  orderId: string,
  callerGone: () => boolean,
  /** Place the runner on a box this request just claimed; null when it cannot yet (B2). */
  placeOnClaimed: (instance: Instance) => Promise<Outcome | null>,
  /** Place the runner on a ready box of the owner's as of now; null when there is none. */
  placeIfReady: () => Promise<Outcome | null>,
  /**
   * Anthropic-managed git for this owner:
   * with the flag on, a warm box may be claimed for an owner the Add box gate
   * refuses, since the session's own git never touches the broker; a cold
   * launch for an owner without a stored termag GitHub credential is never
   * made, flag or no flag (github-first GATE-1).
   */
  git: { anthropicGit: boolean } = { anthropicGit: false },
): Promise<Outcome> {
  const retry = (r: Refusal): Outcome => refused(r);
  const gone = (): Outcome => {
    console.warn(`[CLAUDE-RUNNER] order ${orderId}: the spawn hook stopped waiting; no box started for it (the session is re-offered)`);
    return retry(REFUSAL.hookGone('box'));
  };
  // The caller saw no ready box before it took the lock; the session ahead
  // of it in a burst may have claimed one and placed on it since. Re-read
  // under the lock and use that box rather than wait on it.
  const placed = await placeIfReady();
  if (placed) return placed;
  const owned = await prisma.instance.findMany({
    where: { userId: user.id, kind: 'ec2', status: { not: 'terminated' } },
    select: { id: true, name: true, kind: true, status: true, ec2InstanceId: true, lastConnectedAt: true, createdAt: true },
  });
  const plan = autoBoxPlan(owned);
  if (plan.kind === 'wait') return retry(REFUSAL.boxWait(plan.reason));
  if (plan.kind === 'hold') return retry(REFUSAL.boxHold(plan.reason));

  if (plan.kind === 'start') {
    // A start resumes a hibernated box too (boxPowerPolicy); say which it was.
    const verb = plan.box.status === 'hibernated' ? 'resuming' : 'starting';
    const instance = await prisma.instance.findUnique({ where: { id: plan.box.id } });
    const refusal = powerRequestError(instance, user.id, 'start', isBoxProvisioningConfigured());
    if (refusal || !instance) {
      return retry(REFUSAL.boxStartFailed(plan.box.name, plan.box.status, refusal?.error ?? 'not found'));
    }
    if (callerGone()) return gone();
    try {
      // As the owner's own Start does (routes/instances.ts): the idle clock
      // restarts and parkedAt clears in the same write, so a box the
      // lifecycle sweep parked is not parked again, on its old clock, the
      // moment the session ends (Bugbot on #191).
      await requestPower(instance, 'start', { markInUse: true });
      console.log(`[CLAUDE-RUNNER] order ${orderId}: ${verb} ${plan.box.status} box ${instance.name} (${instance.id}) for ${user.unixUsername}`);
    } catch (err) {
      if (!(err instanceof PowerRequestConflict)) {
        console.error(`[CLAUDE-RUNNER] order ${orderId}: start of ${instance.name} failed:`, err instanceof Error ? err.message : String(err));
        return retry(REFUSAL.boxStartFailed(instance.name, plan.box.status, null));
      }
    }
    return retry(REFUSAL.boxStarting(verb, instance.name));
  }

  if (!isBoxProvisioningConfigured()) return retry(REFUSAL.noProvisioning());
  // The same gate as the Add box button (#226): where the broker is configured
  // and the flag is on, a managed box needs a stored GitHub token. Retryable:
  // the session is retried once the owner has connected GitHub. Under
  // Anthropic-managed git it still rules the cold launch, not the warm claim.
  const facts = await readBoxCreationFacts(flagIdentity(user));
  const creation = boxCreationRefusal(facts);
  if (creation && !git.anthropicGit) return retry(REFUSAL.boxCreationRefused(creation.body.error));
  // Never a cold box for an owner without a stored termag GitHub credential
  // where one is required, whatever the gate's flag says: github-first's
  // GATE-1 holds for every entry point. The stored row decides, not the
  // spawn's credential read, which can fail (KMS) and must not open the gate.
  const noColdBox = creation ?? (facts.required && !facts.hasGithubCredential
    ? { body: { error: 'Connect GitHub in Settings before adding a box' } }
    : null);
  // Asked again inside each write's own transaction: the owner's lock covers
  // this process only, and the names below dodge every existing row, so a
  // unique-index clash alone would not say another process got there first.
  const stillNeeded = (owned: OwnedBox[]) => autoBoxPlan(owned).kind === 'acquire';
  // The owner's box-image and box-hibernation-enabled flags, read once so the
  // claim decision and the launch agree, as Add box does (routes/instances.ts
  // createBox): a pool box runs the published image with the pool's
  // hibernation value, so an owner whose flags say otherwise takes the cold path.
  const image = await boxImageSelectionFor(flagIdentity(user));
  const hibernation = await ownerHibernationEnabled(flagIdentity(user));
  try {
    if (await boolVariation(WARM_POOL_ENABLED_FLAG, flagIdentity(user), false) && isPublished(image) && hibernation === await poolHibernationEnabled()) {
      const currentHash = await poolSpecHashOrNull();
      if (currentHash) {
        // A name free across all of the owner's rows: terminated ones still
        // hold theirs in the (userId, name) unique index.
        const taken = new Set((await prisma.instance.findMany({ where: { userId: user.id }, select: { name: true } })).map(i => i.name));
        if (callerGone()) return gone();
        // B3: an owner who can have no cold box runs only under
        // Anthropic-managed git, which only a wrapper that understands the
        // flags can start, so their claim takes only a pool box whose agent
        // announces the capability (a pool hello carries it). Claiming any
        // other would leave them owning a box that placement refuses with
        // `github` on every re-offer, with no termag access to fix it
        // (Bugbot on #285). With nothing capable in the pool, the refusal
        // below is the cold path's: box-creation-refused, never a cold box.
        const eligible = noColdBox
          ? (id: string) => instanceAgentTransport(id)?.capabilities.includes(WRAPPER_FLAGS_CAPABILITY) ?? false
          : undefined;
        const claim = await claimWarmBox({ owner: user, boxName: pickFreeBoxName(taken, autoBoxName()), currentHash, stillNeeded, parentInstanceId: null, eligible }, prismaClaimEffects);
        if (claim.claimed) {
          void reconcileWarmPool();
          console.log(`[CLAUDE-RUNNER] order ${orderId}: claimed warm box ${claim.instance.name} (${claim.instance.id}) for ${user.unixUsername}`);
          // The agent is already connected (a warm box's is), so place now when
          // its credentials have landed and it can run a runner; else the box
          // is theirs and the re-offer places on it.
          return (await placeOnClaimed(claim.instance)) ?? retry(REFUSAL.boxClaimed(claim.instance.name));
        }
        console.log(`[CLAUDE-RUNNER] order ${orderId}: warm claim fell through (${claim.reason}${eligible ? `, ${WRAPPER_FLAGS_CAPABILITY} boxes only` : ''}); ${noColdBox ? 'no cold box without GitHub connected' : 'provisioning cold'}`);
      }
    }
    if (noColdBox) return retry(REFUSAL.boxCreationRefused(noColdBox.body.error));
    // Cold: minutes, async. The next spawn sees the box as `provisioning` and waits.
    if (callerGone()) return gone();
    const name = await provisionNewBox(user, autoBoxName(), stillNeeded, { image, hibernation });
    // Provisioning is configured (checked above), so null means the re-check
    // found a box already on its way.
    if (!name) return retry(REFUSAL.boxOnItsWay());
    console.log(`[CLAUDE-RUNNER] order ${orderId}: cold-provisioning box ${name} for ${user.unixUsername}`);
    return retry(REFUSAL.boxProvisioning(name));
  } catch (err) {
    // Two processes passed the re-check together: their serializable
    // transactions conflict (P2034), or the names collide (P2002). One box is
    // on its way, which is all this wants.
    if (isNameConflict(err) || isConcurrentCreate(err)) return retry(REFUSAL.boxOnItsWay());
    throw err;
  }
}

export const DRAINING_ERROR = 'this orchestrator is draining for a deploy; retried on the serving one';

/**
 * `isServing` is the drain's (services/orchestratorDrain.ts): a displaced
 * process answers every spawn 503 at once, before it looks for a box, because
 * the boxes' agents are moving to the serving process.
 */
export function claudeRunnerRouter(spawnToken: string, isServing: () => boolean = () => true, opts: { placementBudgetMs?: number } = {}): Router {
  const router = Router();
  const budgetMs = opts.placementBudgetMs ?? PLACEMENT_BUDGET_MS;
  // Where a session's own OpenTelemetry goes, handed to the box script as
  // flags (services/claudeRunnerSpawn.ts, runnerLaunch); null ships nothing.
  const telemetry = otlpDestinationFromEnv(process.env);

  const authorize: RequestHandler = (req, res, next) => {
    const presented = bearerToken(req.headers.authorization);
    if (!isLocalPeer(req) || !presented || !tokensEqual(presented, spawnToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  const spawn: RequestHandler = async (req, res) => {
    // The hook stops waiting after curl's --max-time, and the orchestrator then
    // backs off and re-offers the session. A launch queued behind the owner's
    // lock past that point would start a runner nobody is waiting for.
    let callerGone = false;
    res.on('close', () => { if (!res.writableFinished) callerGone = true; });
    const startedAt = Date.now();
    const budgetLeft = () => budgetMs - (Date.now() - startedAt);

    const parsed = parseSpawnBody(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { orderId, sessionId, accountEmail, workOrder, accountId } = parsed;
    if (!isServing()) {
      console.log(`[CLAUDE-RUNNER] order ${orderId}: 503 draining`);
      res.status(503).json({ error: DRAINING_ERROR });
      return;
    }

    // Same match as sign-in: the insensitive query only narrows, an exact
    // compare decides (`_`/`%` are ILIKE wildcards on Postgres).
    let user = await findUserByEmail(accountEmail);
    let createdUser = false;
    // Auto-user: an owner the
    // allowlist admits but who never signed in gets a row here instead of the
    // 404, when both flags are on for them (read on a context keyed by their
    // Anthropic account id, the one identity there is before a row exists)
    // and the hook sent that id, which the placeholder provider id is built
    // from. Serialized per email: a burst of spawns creates one row.
    if (!user && accountId) {
      const allowed = parseAllowedUsers(process.env.ALLOWED_USERS);
      const pending = pendingOwnerContext(accountId, accountEmail, resolveUnixUsername(allowed, accountEmail) ?? '');
      if (await boolVariation(CLAUDE_RUNNER_AUTO_BOX_FLAG, pending, false) && await boolVariation(CLAUDE_RUNNER_AUTO_USER_FLAG, pending, false)) {
        // The display name is a fallback worth at most a few seconds: looked
        // up before the lock, so a slow Slack call holds no other spawn for
        // this address, and bounded, so it never eats the hook's budget
        // (Bugbot on #288).
        const realName = await Promise.race([slackRealName(accountEmail), new Promise<null>(r => setTimeout(() => r(null), SLACK_NAME_BUDGET_MS).unref?.())]);
        const made = await serializeByKey(`claude-runner:new:${accountEmail.toLowerCase()}`, async () => {
          // A burst's earlier spawn may have made the row while this one waited.
          const raced = await findUserByEmail(accountEmail);
          if (raced) return { kind: 'existing' as const, user: raced };
          return createOwnerFromAllowlist({ email: accountEmail, accountId, realName }, allowed);
        });
        if (made.kind === 'created' || made.kind === 'existing') {
          user = made.user;
          createdUser = made.kind === 'created';
        } else if (made.kind === 'collision') {
          // The derived username, never the email: the journal is read project-wide.
          console.log(`[CLAUDE-RUNNER] order ${orderId}: 404 the session owner is not a termag user and could not be created: unix username ${made.unixUsername} belongs to another user`);
        } else if (made.kind === 'account-bound') {
          console.log(`[CLAUDE-RUNNER] order ${orderId}: 404 the session owner is not a termag user and could not be created: the account id already belongs to termag user ${made.unixUsername} under another email; not rebound from the spawn body`);
        }
      }
    }
    if (!user) {
      // Deliberately not the email, in the line or the response: the hook's
      // stderr lands in the Activity tab, and the journal is read project-wide.
      console.log(`[CLAUDE-RUNNER] order ${orderId}: 404 the session owner is not a termag user`);
      res.status(404).json({ error: 'the session owner is not a termag user; sign in to termag once, then retry from the Activity tab', code: OWNER_NOT_FOUND });
      return;
    }
    // One line per outcome, owner named (see the header), refusals included:
    // how often an owner is queued or refused is answerable from the journal.
    const who = user.unixUsername;
    // Every flag read on this owner: their own id, or the `claude:<account
    // id>` placeholder while they have one, the key creation was decided on
    // (services/claudeRunnerOwner.ts, flagIdentity).
    const ldUser = flagIdentity(user);
    const outcomeLine = (status: number, text: string) => console.log(`[CLAUDE-RUNNER] order ${orderId} for ${who}: ${status} ${text}`);
    // The session's event log (services/claudeSessionEvents.ts): one event per
    // outcome, a refusal's reason included, so the owner's UI shows a queued
    // session and why. Best effort; never changes the hook's answer.
    const event = (kind: SessionEventKind, detail: string | null = null, instanceId: string | null = null, code: string | null = null) => {
      // The product event beside it (services/productEvents.ts): queued (a
      // refusal, with its code) or placed. The detail text stays out.
      if (kind === 'queued' || kind === 'placed') {
        recordProductEvent(`cloud.session.${kind}`, { user: user.id, box: instanceId }, { provider: 'claude', kind: 'cloud', code });
      }
      return recordSessionEvent({ owner: { id: user.id, unixUsername: who }, sessionId, orderId, instanceId, kind, detail, code });
    };
    // A refusal (services/claudeRunnerSpawn.ts, REFUSAL): the text is the
    // outcome line, the event's detail and the hook's stderr; the code rides
    // on the event and in the body, where an old hook ignores it.
    const refuse = async (outcome: Outcome) => {
      const text = String(outcome.body.error);
      const code = typeof outcome.body.code === 'string' ? outcome.body.code : null;
      outcomeLine(outcome.status, text);
      await event(outcome.status === 502 ? 'agent-failed' : 'queued', text, null, code);
      res.status(outcome.status).json(outcome.body);
      // The owner notice (services/claudeRunnerNotices.ts, F1): after the
      // answer, best effort, behind its own flag; the box name when the text
      // carries one.
      if (code) {
        const named = /box "([^"]+)"/.exec(text);
        void notifyRefusal(user, sessionId, code as RefusalCode, text, named ? named[1] : null);
      }
    };
    try {
      if (createdUser) {
        // One line and one event per first-time engineer (U5), so the journal
        // and the admin view can count them.
        console.log(`[CLAUDE-RUNNER] order ${orderId}: created termag user ${who} for the session owner`);
        await event('user-created');
      }

      // Per-engineer gate 2: on a broker host the box clones with the owner's
      // stored gh token, so an owner who never connected GitHub would get a
      // runner that fails at checkout. Say so now, retryably.
      const store = getCredentialStoreConfig();
      const brokerConfigured = !!(store && getGithubBrokerUrl());
      let credential: 'present' | 'absent' | 'unknown' = 'unknown';
      if (store && brokerConfigured) {
        try {
          credential = (await githubStoreDeps(store, user.id).read()) ? 'present' : 'absent';
        } catch (err) {
          console.warn(`[CLAUDE-RUNNER] order ${orderId}: GitHub credential read failed, not holding it against the owner:`, err instanceof Error ? err.message : String(err));
        }
      }
      const gate = githubGate({ brokerConfigured, credential });
      // Anthropic-managed git: with
      // the flag on, the session's own clone, fetch and push go through
      // Anthropic with the owner's claude.ai GitHub token, so the gate above
      // is advisory: the launch tells the wrapper the credential state and
      // the session says what still needs it. Only a box whose wrapper
      // understands the flags can run that way; the placement checks.
      const anthropicGit = await boolVariation(CLAUDE_RUNNER_ANTHROPIC_GIT_FLAG, ldUser, false);
      const githubState: GithubLaunchState = !brokerConfigured ? 'unknown' : credential === 'present' ? 'connected' : credential === 'absent' ? 'absent' : 'unknown';
      const gateRefused = !gate.ok;
      if (gateRefused && !anthropicGit) {
        await refuse(refused(REFUSAL.githubNotConnected()));
        return;
      }

      /** The owner's ready EC2 boxes as of now, with what their agents announce. */
      const readyCandidates = async () => {
        const rows = await prisma.instance.findMany({
          where: { userId: user.id, kind: 'ec2', status: 'ready' },
          select: { id: true, kind: true, status: true, hostHome: true, hostUnixUser: true, lastConnectedAt: true, name: true },
        });
        return rows.map(b => {
          const caps = instanceAgentTransport(b.id)?.capabilities ?? [];
          return {
            ...b,
            connected: isInstanceAgentConnected(b.id),
            capable: caps.includes(RUNNER_AGENT_CAPABILITY),
            wrapperCapable: caps.includes(WRAPPER_FLAGS_CAPABILITY),
          };
        });
      };
      const candidates = await readyCandidates();
      const boxes = runnerBoxes(candidates);
      // A box whose wrapper predates the git flags cannot run the proxy: for
      // an owner the gate refused it takes no new session, as if the flag
      // were off. It still counts for "already running": an order live on
      // such a box must not get a second runner elsewhere, and a retry for
      // it must hear so rather than the GitHub refusal, so the refusal for
      // "no eligible box" is placement's, after the sessions are listed
      // (placeRunner, `full` with no eligible box; Bugbot on #287).
      const eligible = (box: { wrapperCapable?: boolean }) => !gateRefused || !!box.wrapperCapable;
      /** The git flags for a launch on `box`: only where its wrapper understands them. */
      const gitFor = (box: { wrapperCapable?: boolean }): RunnerGitOptions | null =>
        anthropicGit && box.wrapperCapable ? { anthropicGit: true, github: githubState } : null;

      /**
       * Place the order on one of `boxes` (best first): read every box's live
       * runner sessions, pick a slot, record, write the work order and create
       * the runner's tmux session. Runs under the owner's lock, which the
       * caller holds: it reads every box's tmux sessions and then creates one,
       * and the orchestrator runs several hooks at once (a retry can also
       * race its own first attempt).
       */
      const placeOnBoxes = async (targets: Array<CandidateBox & { name: string }>): Promise<Outcome> => {
        let listed;
        try {
          listed = await Promise.all(targets.map(async box => {
            const reply = await sendToInstanceAgent(box.id, 'tmux-list', {});
            const names: string[] = Array.isArray(reply?.sessions) ? reply.sessions : [];
            return { box, sessions: parseRunnerSessions(names, box.hostUnixUser!) };
          }));
        } catch (err) {
          // Not knowing one box's sessions could start a second runner for an
          // order already running there; retry instead.
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[CLAUDE-RUNNER] order ${orderId}: listing the owner's boxes failed: ${msg}`);
          return refused(REFUSAL.agentListFailed(msg));
        }

        const placement = placeRunner(listed, orderId, MAX_RUNNERS_PER_BOX, eligible);
        if (placement.kind === 'existing') {
          const { box, slot } = placement;
          return { status: 200, body: { ok: true, instanceId: box.id, boxName: box.name, sessionName: runnerLaunch(box.hostHome!, box.hostUnixUser!, orderId, slot).sessionName, slot, alreadyRunning: true } };
        }
        // No eligible box at all means every ready box has an old wrapper and
        // the owner has no termag GitHub credential: that is the GitHub
        // refusal, not "boxes full" (Bugbot on #287).
        if (placement.kind === 'full') return refused(placement.boxes === 0 ? REFUSAL.githubNotConnected() : REFUSAL.boxesFull(placement.boxes, placement.max));
        if (callerGone) {
          console.warn(`[CLAUDE-RUNNER] order ${orderId}: the spawn hook stopped waiting; not launching (the session is re-offered)`);
          return refused(REFUSAL.hookGone('launch'));
        }

        const { box, slot } = placement;
        // A delivery still running to the box (a claim's, or the owner's
        // credential change) would leave the runner a half-written settings
        // file to copy: wait for it inside the budget, else retry later.
        if (!await deliverySettled(box.id, budgetLeft())) {
          console.log(`[CLAUDE-RUNNER] order ${orderId}: box ${box.name} is still receiving its credentials; not launching yet`);
          return refused(REFUSAL.boxSettling(box.name));
        }
        if (callerGone) {
          console.warn(`[CLAUDE-RUNNER] order ${orderId}: the spawn hook stopped waiting; not launching (the session is re-offered)`);
          return refused(REFUSAL.hookGone('launch'));
        }
        const launch = runnerLaunch(box.hostHome!, box.hostUnixUser!, orderId, slot, telemetry, { user: user.id, box: box.id }, gitFor(box));
        const rpc = (type: string, payload: Record<string, unknown>) => sendToInstanceAgent(box.id, type, payload);
        // The session record, before the launch: a runner that exits at once
        // reports its end within a second, and the report needs the row
        // (services/claudeRunnerSessions.ts); startedAt is the launch time, not
        // the insert's. Best effort: a failed write is logged and the launch
        // goes ahead. A relaunch of an order whose runner vanished moves the
        // row to this box and slot.
        let recorded = false;
        try {
          await recordRunnerStart({ orderId, sessionId, userId: user.id, instanceId: box.id, slot, startedAt: new Date() });
          recorded = true;
        } catch (err) {
          console.error(`[CLAUDE-RUNNER] order ${orderId}: recording the start failed:`, err instanceof Error ? err.message : String(err));
        }
        try {
          // The JWT is in `content` only; sendToInstanceAgent logs nothing.
          await rpc('write-file', { path: launch.workOrderPath, content: `${workOrder}\n`, mode: launch.workOrderMode });
          const created = await rpc('tmux-create', { sessionName: launch.sessionName, cwd: launch.cwd, gitInit: launch.gitInit, command: launch.command });
          if (created?.created === false) {
            // The name is unique to this order and was absent a moment ago, under
            // the owner's lock: only a launch of this same order made it. The
            // row now names that launch's box and slot, which are these.
            return { status: 200, body: { ok: true, instanceId: box.id, boxName: box.name, sessionName: launch.sessionName, slot, alreadyRunning: true } };
          }
        } catch (err) {
          // Best effort: drop the session if it got that far (tmux-create may
          // have timed out after creating it), then empty the work order (the
          // box script refuses an empty one), and take the record back: no
          // runner ran.
          await rpc('tmux-kill', { sessionName: launch.sessionName, exact: true }).catch(() => {});
          await rpc('write-file', { path: launch.workOrderPath, content: '' }).catch(() => {});
          if (recorded) await discardRunnerStart(orderId).catch(e => console.error(`[CLAUDE-RUNNER] order ${orderId}: discarding the start failed:`, e instanceof Error ? e.message : String(e)));
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[CLAUDE-RUNNER] order ${orderId}: launch on ${box.name} (${box.id}) failed: ${msg}`);
          return refused(REFUSAL.agentLaunchFailed(msg));
        }
        return { status: 202, body: { ok: true, instanceId: box.id, boxName: box.name, sessionName: launch.sessionName, slot } };
      };

      /**
       * A box this request just claimed from the warm pool (getOwnerABox): a
       * warm box's agent is connected, so it can take the runner now, once
       * the claim's credential delivery has landed (the runner copies the
       * box's Claude settings at start) and if it announces
       * the runner capability. Null means "not now": the box is the owner's
       * and the re-offer places on it.
       */
      const placeOnClaimed = async (instance: Instance): Promise<Outcome | null> => {
        const caps = instanceAgentTransport(instance.id)?.capabilities ?? [];
        const candidate: CandidateBox & { name: string } = {
          id: instance.id, kind: instance.kind, status: 'ready', name: instance.name,
          hostHome: instance.hostHome, hostUnixUser: instance.hostUnixUser, lastConnectedAt: instance.lastConnectedAt,
          connected: isInstanceAgentConnected(instance.id),
          capable: caps.includes(RUNNER_AGENT_CAPABILITY),
          wrapperCapable: caps.includes(WRAPPER_FLAGS_CAPABILITY),
        };
        if (runnerBoxes([candidate]).length === 0 || (gateRefused && !candidate.wrapperCapable)) {
          console.log(`[CLAUDE-RUNNER] order ${orderId}: claimed box ${instance.name} cannot take the runner yet (agent ${candidate.connected ? 'connected' : 'not connected'}, ${candidate.capable ? 'capable' : 'not capable'}${gateRefused && !candidate.wrapperCapable ? ', wrapper predates Anthropic-managed git and the owner has no termag GitHub credential' : ''}); the re-offer places on it`);
          return null;
        }
        // placeOnBoxes waits for the claim's credential delivery to settle
        // (deliverySettled) before it launches, and answers box-wait past the
        // budget: the box is theirs and the re-offer places on it.
        return placeOnBoxes([candidate]);
      };

      /** A ready box of the owner's as of now (a burst's earlier session may have claimed one): place on it, else null. */
      const placeIfReady = async (): Promise<Outcome | null> => {
        const fresh = runnerBoxes(await readyCandidates());
        return fresh.length > 0 ? placeOnBoxes(fresh) : null;
      };

      /** The outcome's log line, event and answer, placements and refusals alike. */
      const finish = async (outcome: Outcome) => {
        if (outcome.status === 202) {
          console.log(`[CLAUDE-RUNNER] order ${orderId} for ${who} started on ${outcome.body.boxName} (${outcome.body.instanceId}) as ${outcome.body.sessionName} (slot ${outcome.body.slot})`);
          await event('placed', `${outcome.body.boxName} slot ${outcome.body.slot}`, String(outcome.body.instanceId));
          res.status(outcome.status).json(outcome.body);
          // A session running with Anthropic-managed git and no termag GitHub
          // credential: the weekly reminder (F2), after the answer.
          if (anthropicGit && githubState === 'absent') void notifyGithubAbsent(user, sessionId, String(outcome.body.boxName));
          return;
        } else if (outcome.status === 200) {
          console.log(`[CLAUDE-RUNNER] order ${orderId} for ${who} already running on ${outcome.body.boxName} (${outcome.body.instanceId}) slot ${outcome.body.slot}`);
          await event('already-running', `${outcome.body.boxName} slot ${outcome.body.slot}`, String(outcome.body.instanceId));
        } else {
          await refuse(outcome);
          return;
        }
        res.status(outcome.status).json(outcome.body);
      };

      if (boxes.length === 0) {
        // A connected box with an outdated agent is a box: say so rather than
        // buy another.
        if (runnerBoxes(candidates.map(b => ({ ...b, capable: true }))).length > 0) {
          await refuse(refused(REFUSAL.agentOutdated()));
          return;
        }
        if (!await boolVariation(CLAUDE_RUNNER_AUTO_BOX_FLAG, ldUser, false)) {
          await refuse(refused(REFUSAL.noBox()));
          return;
        }
        // Under the same lock as placement: a second session of a burst waits
        // here and then sees the first one's box on its way. A 503 (the
        // session is retried once the box connects) is a `queued` event with
        // what was done; a warm box claimed and placed in this request is a 202.
        await finish(await serializeByKey<Outcome>(ownerPlacementKey(user.id), () => getOwnerABox(user, orderId, () => callerGone, placeOnClaimed, placeIfReady, { anthropicGit })));
        return;
      }

      await finish(await serializeByKey<Outcome>(ownerPlacementKey(user.id), () => placeOnBoxes(boxes)));
    } catch (err) {
      // A throw past this point (the instance query, the lock) answers 500
      // through apiErrorHandler, which logs the stack; the owner's outcome
      // line is logged here so the count of failed orders stays complete.
      outcomeLine(500, err instanceof Error ? err.message : String(err));
      await event('agent-failed', 'internal error');
      throw err;
    }
  };

  router.post('/spawn', authorize, asyncHandler(spawn));
  return router;
}
