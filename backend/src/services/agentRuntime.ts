import * as tmux from './tmux';
import { instanceAgentTransport, isProjectAgentConnected, sendForProject } from './agentRegistry';
import { launchCommandFor } from './launchCommand';
import { claimSpawnLaunch, isParkedSpawn, releaseSpawnLaunch, unparkOnLaunch } from './agentSpawnStore';
import { watchLaunchedSpawn } from './spawnStatusLog';
import { spawnFolderTrust } from './agentSpawn';
import { claimHandoffLaunch, releaseHandoffLaunch } from './agentHandoffStore';
import { registerPollerSession, unregisterPollerSession } from './tmuxPoller';
import { PROVIDERS, isBackendFor } from '../providers/registry';
import { isClaudeCode, isModelFor } from './modelChoices';
import { fireworksContext, type FireworksModels } from './fireworksGateway';
import { fireworksModelsForBox } from './fireworksFlag';
import { refusalLine } from './launchCommand';
import { classifyForeground } from './foregroundProbe';
import { refuseUnreadySessions, SessionGateError, type SetupAdmission } from './sessionGate';
import { recordProductEvent } from './productEvents';
import { rememberUserKey } from './userKeys';
import { firstPromptLaunchCommand, firstPromptPath } from './firstPrompt';
import { resolveProjectRoot } from './projectPaths';
import { prisma } from '../db';


/**
 * Ask the right agent (the project's box if any, else the user's legacy
 * agent) whether an agent process is running in a given tmux session.
 *
 *   'running'     — foreground command looks like an agent (claude, codex, etc.)
 *   'not-running' — session doesn't exist or pane is just a shell
 *   'busy'        — git or a git-* helper is the process-group leader. A
 *                   checkout fetch has to be that leader: a subshell wrapping
 *                   it shows up here as bash or zsh and looks idle.
 *   'unknown'     — RPC failed; we can't tell. Callers should NOT relaunch
 *                   into "unknown" because typing keys into a session whose
 *                   state we can't verify could clobber an active prompt.
 */
async function probeAgentSession(
  project: { userId: string; instanceId: string | null },
  sessionName: string,
): Promise<'running' | 'not-running' | 'unknown' | 'busy'> {
  try {
    const result = await sendForProject(project, 'tmux-foreground-cmd', { sessionName });
    return classifyForeground(result?.cmd);
  } catch {
    return 'unknown';
  }
}

/** What an agent announces when it can pre-accept Claude Code's folder-trust prompt (agent/claude-trust.js). */
const CLAUDE_TRUST_CAPABILITY = 'claude-trust-folder-v1';

/**
 * Before a spawned Claude starts on its brief: mark its folder trusted, so it
 * does not sit at "Is this a project you trust?" with the brief unread. Only
 * when spawnFolderTrust names a check, which the box makes against the folder
 * on disk (an empty new project, or the owner-trusted project's own tree), and
 * the box's agent can do it; otherwise the prompt stays for the user. Never
 * throws: the launch goes on either way.
 */
async function trustSpawnFolder(
  host: { userId: string; instanceId: string | null },
  k: { provider: string; capabilities: readonly string[]; project: { repoUrl: string | null; chatTrustedAt: Date | null } | null | undefined; projDir: string; label: string },
): Promise<void> {
  const check = spawnFolderTrust(k.project);
  if (k.provider !== 'claude' || !check || !k.capabilities.includes(CLAUDE_TRUST_CAPABILITY)) return;
  try {
    const r = await sendForProject(host, 'claude-trust-folder', { path: k.projDir, check }, 45_000);
    if (r?.changed) console.log(`[SPAWN] ${k.label}: marked ${k.projDir} trusted for Claude Code (${check})`);
  } catch (err) {
    console.log(`[SPAWN] ${k.label}: folder left untrusted, Claude will ask (${check}):`, (err as Error).message);
  }
}

/**
 * One launch at a time per agent pane. Reconnect reconstruction and a
 * handoff restart's relaunch can reach the same killed pane at once; without
 * this both probe "no agent" before either types, and the second types its
 * launch on top of the first (the resume command over the handoff, say).
 * Under the lock the second waits, and its probe — after the first has typed
 * and the 500 ms settle — sees the agent the first one started. In-process:
 * both paths run in the orchestrator that holds the box's socket.
 */
const paneLocks = new Map<string, Promise<unknown>>();
/**
 * The lock outlives a launch that typed by this long (the caller is not held
 * up): the agent typed into the pane needs a moment to become its foreground
 * process, and reconstruction probes before its own settle, so a second
 * launcher let in at once could still see the shell.
 */
export const PANE_LAUNCH_SETTLE_MS = 1_000;
let paneLaunchSettleMs = PANE_LAUNCH_SETTLE_MS;

/** Tests that launch into one pane again and again set this to 0 rather than wait it out each time. */
export function setPaneLaunchSettleForTests(ms: number): void {
  paneLaunchSettleMs = ms;
}

export async function withPaneLock<T>(key: string, fn: () => Promise<T>, settleMs: (result: T) => number = () => 0): Promise<T> {
  const prev = paneLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.then(r => settleMs(r), () => 0).then(ms => (ms ? new Promise(resolve => setTimeout(resolve, ms)) : undefined));
  paneLocks.set(key, tail);
  void tail.then(() => { if (paneLocks.get(key) === tail) paneLocks.delete(key); });
  return run;
}

export function paneLockKey(instanceId: string | null, session: string): string {
  return `${instanceId ?? 'local'}:${session}`;
}

export function resolveAgentProvider(
  workflowProvider?: string | null,
  userDefaultProvider?: string | null,
): string {
  return workflowProvider ?? userDefaultProvider ?? 'claude';
}

interface AgentRuntimeContext {
  userId: string;
  unixUsername: string;
  projectName: string;
  provider: string;
  /** The project's instanceId, or null if it lives on the user's legacy agent. */
  instanceId: string | null;
  /** Workstream name — 'main' for single-workstream projects (the default). */
  workstream: string;
  /**
   * The box's `Instance.hostHome`. Omitted by callers that don't have the
   * instance loaded, which resolves the project dir the way it always was.
   */
  hostHome?: string | null;
  /**
   * Shell to run in the agent pane BEFORE the agent's launch command (joined
   * with `&&`, so a failure leaves the pane at a prompt showing the error
   * rather than starting the agent in a half-made dir). Used for the pane
   * checkout of a repo project (services/projectTemplates.ts). Only honoured
   * on first launch; reconnects relaunch the bare agent. What keeps
   * reconstruction from typing the bare resume into that pane first is the
   * session gate: the project stays `pending` until this launch has typed the
   * clone, and reconstruction skips it until then.
   */
  preLaunch?: string;
  /**
   * The browser session recording the launch came from (its id). A
   * Claude launch on a box that can print the settings types it in, so the
   * session's spans are filed under that replay (services/launchCommand.ts).
   * Only on a first launch from a browser; reconnects relaunch the bare agent.
   */
  replaySessionId?: string | null;
  /** Lets the setup owner (services/projectClone.ts) launch before it commits the move. */
  admission?: SetupAdmission;
  /** The agent spawn whose brief this launch starts on, when the caller made one (routes/spawns.ts). */
  spawnId?: string | null;
  /**
   * Continue the pane's last conversation (the provider's resumeCommand)
   * instead of starting fresh: a parked spawn brought back.
   */
  resume?: boolean;
  /**
   * What the agent's first launch starts on, when the user wrote it (a new
   * workstream for a PR, services/firstPrompt.ts). A spawn's brief or a
   * handoff wins; a provider without promptLaunch launches bare.
   */
  firstPrompt?: string | null;
  /**
   * The model backend to start the agent on (Workflow.backend).
   * Absent = the workstream's agent row says; null = the
   * harness's default.
   */
  backend?: string | null;
  /** The model to start on (Workflow.model); absent = the row says, null = the backend's default. */
  model?: string | null;
}

/** What a launch starts on (launchChoice): the backend, the model, and on Fireworks its fast model and context window. */
export interface LaunchModel {
  backend: string | null;
  model: string | null;
  fastModel?: string;
  context?: number;
  // Typed instead of the agent: the backend cannot be used for this owner and box.
  refusal?: string;
}

/**
 * The backend and model a launch of this provider uses, from what the
 * workstream's row says. A backend the provider cannot
 * run on, or a model no longer offered, falls back to the default. On
 * Fireworks the models are the fireworks-models flag for the owner and box:
 * no model picked starts on its default, and with the flag off the pane says
 * so rather than starting the agent on a model the gateway will refuse.
 */
export function launchChoice(
  provider: string, backend: string | null | undefined, model: string | null | undefined, fireworks: FireworksModels | null,
): LaunchModel {
  const b = backend && isBackendFor(provider, backend) ? backend : null;
  if (b !== 'fireworks') return { backend: b, model: model && isModelFor(provider, b, model, null) ? model : null };
  if (!fireworks) {
    return {
      backend: b, model: null,
      refusal: refusalLine(`termag: Fireworks models are not on for you (feature flags fireworks-enabled and fireworks-models); switch this workstream to the default backend, or ask for access`),
    };
  }
  const m = model && fireworks.models.some(x => x.id === model) ? model : fireworks.defaultModel;
  // Claude Code takes one context window for every model it does not know,
  // its small/fast model included, so the smaller of the two.
  const windows = (isClaudeCode(provider) ? [m, fireworks.fastModel] : [m]).map(id => fireworksContext(fireworks, id));
  const context = windows.every(w => w !== null) ? Math.min(...(windows as number[])) : undefined;
  return { backend: b, model: m, fastModel: fireworks.fastModel, ...(context ? { context } : {}) };
}

/** launchChoice with the flags read for the owner and box; a failed read is no Fireworks. */
export async function resolveLaunch(
  provider: string, backend: string | null | undefined, model: string | null | undefined, userId: string, instanceId: string | null,
): Promise<LaunchModel> {
  const fireworks = backend === 'fireworks' && instanceId
    ? await fireworksModelsForBox(userId, instanceId).catch((err: Error) => {
      console.warn(`[LAUNCH] fireworks flags for instance ${instanceId} unreadable: ${err.message}`);
      return null;
    })
    : null;
  return launchChoice(provider, backend, model, fireworks);
}

/**
 * The workstream's agent row's backend and model. A failed read launches on
 * the default, as a failed brief or handoff lookup launches plain.
 */
async function workflowChoice(projectId: string, workstream: string): Promise<{ backend: string | null; model: string | null }> {
  try {
    const row = await prisma.workflow.findFirst({
      where: { projectId, type: 'agent', workstream: { name: workstream } },
      select: { backend: true, model: true },
    });
    return { backend: row?.backend ?? null, model: row?.model ?? null };
  } catch (err) {
    console.warn(`[LAUNCH] ${workstream}: model backend lookup failed, default backend: ${(err as Error).message}`);
    return { backend: null, model: null };
  }
}

/** What a launch did: typed the agent, or left a pane that already had one, git, or an unreadable state. */
export type LaunchOutcome = 'launched' | 'running' | 'busy' | 'unknown';

export async function ensureAgentSessionsAndLaunch(ctx: AgentRuntimeContext): Promise<LaunchOutcome> {
  const session = tmux.sessionName(ctx.unixUsername, ctx.projectName, 'agent', ctx.workstream);
  // The session-name events (services/status.ts) resolve this username to the
  // user id; seeding here keeps the common case off the database.
  rememberUserKey(ctx.unixUsername, ctx.userId);
  const outcome = await withPaneLock(paneLockKey(ctx.instanceId, session), () => launchUnlocked(ctx), r => (r === 'launched' ? paneLaunchSettleMs : 0));
  if (outcome === 'launched') {
    recordProductEvent('agent.session.started', { user: ctx.userId, box: ctx.instanceId }, {
      provider: ctx.provider, kind: 'interactive', resume: !!ctx.resume, spawned: !!ctx.spawnId, clone: !!ctx.preLaunch,
    });
  }
  return outcome;
}

async function launchUnlocked({
  userId,
  unixUsername,
  projectName,
  provider,
  instanceId,
  workstream,
  hostHome,
  preLaunch,
  replaySessionId,
  admission,
  spawnId,
  resume,
  firstPrompt,
  backend: backendOverride,
  model: modelOverride,
}: AgentRuntimeContext): Promise<LaunchOutcome> {
  // Before any RPC: tmux-create makes the dir and git-inits it, which would
  // poison a clone still in progress. A name with no live row is not gated.
  const setup = await prisma.project.findFirst({
    where: { userId, instanceId: instanceId ?? null, name: projectName, archived: false },
    select: { id: true, setupStatus: true, repoUrl: true, chatTrustedAt: true },
  });
  const refusal = setup && refuseUnreadySessions(setup, admission);
  if (refusal) throw new SessionGateError(refusal);

  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  const projDir = tmux.projectDirFor(
    { name: projectName, user: { unixUsername }, instance: { hostHome: hostHome ?? null } },
    workstream,
  );
  const mainSession = tmux.sessionName(unixUsername, projectName, 'agent', workstream);
  const ctrlSession = tmux.sessionName(unixUsername, projectName, 'ctrl', workstream);
  const project = { userId, instanceId };

  if (isProjectAgentConnected(project)) {
    await sendForProject(project, 'tmux-create', { sessionName: mainSession, cwd: projDir });
    await sendForProject(project, 'tmux-create', { sessionName: ctrlSession, cwd: projDir });
    await new Promise(resolve => setTimeout(resolve, 500));

    // The simple UI's chat runner runs this Claude; the pane stays a shell. A
    // repo checkout typed ahead of a pane agent's launch still runs, alone.
    if (config.chatRunner) {
      if (!preLaunch) return 'launched';
      const probe = await probeAgentSession(project, mainSession);
      // Only type the checkout into a free pane: a `running` pane still holds
      // an agent (a chat recreated over an old pane-provider pane), and typing
      // would land in its prompt.
      if (probe === 'running' || probe === 'busy' || probe === 'unknown') return probe;
      await sendForProject(project, 'tmux-send-keys', { sessionName: mainSession, keys: preLaunch, withEnter: true });
      return 'launched';
    }

    // Don't re-launch the agent CLI if it (or any known agent process) is
    // already running in the pane. Skipping on 'unknown' too, since blindly
    // typing into a session whose state we can't verify risks clobbering an
    // active prompt. Same logic as reconstructAgentSessions — keeps the
    // re-create-an-existing-project path from typing `claude` (or `devin`,
    // `cursor`, etc.) into a pane that already has one running.
    const probe = await probeAgentSession(project, mainSession);
    if (probe === 'running' || probe === 'unknown' || probe === 'busy') {
      if (probe === 'unknown') {
        console.warn(`[LAUNCH] ${projectName}: probe failed, skipping send-keys to avoid clobber`);
      }
      if (probe === 'busy') {
        console.warn(`[LAUNCH] ${projectName}: git is in the foreground, skipping send-keys`);
      }
      if (probe !== 'busy' && config.needsPoller) registerPollerSession(mainSession, provider);
      return probe;
    }

    if (config.needsBridge) {
      // The bridge owns the pane (its start sends C-c, clears, launches), so a
      // pre-launch command cannot be chained ahead of it. POST /api/projects
      // rejects repoUrl for bridge providers; this is the belt and braces.
      if (preLaunch) console.warn(`[LAUNCH] ${projectName}: preLaunch ignored for bridge provider ${provider}`);
      // The pane's project and workstream go to the bridge, which puts them in
      // the app server's environment for termag-agent-otel (termag.project,
      // termag.workstream on the resource, as a typed launch's env prefix does).
      await sendForProject(project, 'codex-session-start', { sessionName: mainSession, cwd: projDir, project: projectName, workstream });
    } else {
      const capabilities = instanceId ? instanceAgentTransport(instanceId)?.capabilities ?? [] : [];
      // A spawned agent's first launch starts on its brief,
      // wrapped for telemetry like any other launch.
      const spawned = await claimSpawnLaunch({ spawnId, userId, projectId: setup?.id ?? null, workstream, provider });
      if (spawned) await trustSpawnFolder(project, { provider, capabilities, project: setup, projDir, label: `${projectName}/${workstream}` });
      // A pane a handoff restart just killed starts on the handoff.
      const claim = spawned ? null : await claimHandoffLaunch({ userId, projectId: setup?.id ?? null, workstream, provider });
      // Another process claimed this pane's handoff between our read and our
      // write (overlapping deploys): it is typing the launch, so ours must not.
      if (claim === 'held') {
        console.warn(`[LAUNCH] ${projectName}/${workstream}: another process is starting the handoff in this pane, skipping`);
        return 'running';
      }
      const handedOff = claim;
      const prompted = !spawned && !handedOff && firstPrompt ? await writeFirstPrompt(project, provider, mainSession, firstPrompt, { unixUsername, hostHome }) : null;
      const fresh = resume ? config.resumeCommand ?? config.launchCommand : config.launchCommand;
      const row = backendOverride !== undefined || modelOverride !== undefined
        ? { backend: backendOverride ?? null, model: modelOverride ?? null }
        : setup ? await workflowChoice(setup.id, workstream) : { backend: null, model: null };
      const on = await resolveLaunch(provider, row.backend, row.model, userId, instanceId);
      const launch = on.refusal
        ?? launchCommandFor(spawned?.command ?? handedOff?.command ?? prompted ?? fresh, { replaySessionId, capabilities, provider, project: projectName, workstream, ...on });
      const keys = preLaunch ? `${preLaunch} && ${launch}` : launch;
      // A spawned child's status history from its first turn on (services/spawnStatusLog.ts).
      await watchLaunchedSpawn({ userId, projectId: setup?.id ?? null, workstream, session: mainSession, instanceId });
      try {
        await sendForProject(project, 'tmux-send-keys', { sessionName: mainSession, keys, withEnter: true });
      } catch (err) {
        if (spawned) await releaseSpawnLaunch(spawned.id);
        if (handedOff) await releaseHandoffLaunch(handedOff.id);
        throw err;
      }
      // Only once the launch was typed: whatever path launched it, a parked
      // spawn's pane running again is no longer parked. Until this line the
      // sweep's live-pane guard keeps it from being retired.
      await unparkOnLaunch(userId, setup?.id ?? null, workstream);
    }

    if (config.needsPoller) {
      registerPollerSession(mainSession, provider);
    }
    return 'launched';
  }

  // No agent connected for this project — fall back to local tmux (orchestrator
  // host). Only meaningful for legacy projects that live on the orchestrator
  // itself; instance-bound projects with a disconnected agent fail loudly here
  // because the orchestrator can't see the box's tmux server.
  if (instanceId) {
    throw new Error('Box agent not connected; cannot launch sessions');
  }

  // Legacy local-orchestrator path: only meaningful for the main workstream.
  // Non-main workstreams are git worktrees layered over an existing repo and
  // are managed by the CRUD route, not seeded here.
  if (workstream === 'main') {
    // No wiki seed ahead of a repo fetch (see ensureProjectDir).
    await tmux.ensureProjectDir(unixUsername, projectName, { seedWiki: !preLaunch });
  }
  const mainCreated = await tmux.ensureSession(mainSession, projDir);
  await tmux.ensureSession(ctrlSession, projDir);

  if (!mainCreated) return 'running';

  await new Promise(resolve => setTimeout(resolve, 500));
  if (config.chatRunner) {
    if (preLaunch) await tmux.sendKeys(mainSession, preLaunch);
    return 'launched';
  }
  await tmux.sendKeys(mainSession, preLaunch ? `${preLaunch} && ${config.launchCommand}` : config.launchCommand);

  if (config.needsPoller) {
    registerPollerSession(mainSession, provider);
  }
  return 'launched';
}

/** Put the first prompt in its file on the box; the launch that reads it, or null to launch bare. */
async function writeFirstPrompt(
  project: { userId: string; instanceId: string | null },
  provider: string,
  session: string,
  prompt: string,
  owner: { unixUsername: string; hostHome?: string | null },
): Promise<string | null> {
  const command = firstPromptLaunchCommand(provider, session);
  if (!command) {
    console.warn(`[LAUNCH] ${session}: ${provider} cannot start on a prompt, launching bare`);
    return null;
  }
  const home = resolveProjectRoot({ ownerUnixUser: owner.unixUsername, hostHome: owner.hostHome });
  try {
    await sendForProject(project, 'write-file', { path: firstPromptPath(home, session), content: `${prompt}\n`, mode: 0o600 }, 5000);
  } catch (err) {
    console.warn(`[LAUNCH] ${session}: could not write the first prompt, launching bare:`, (err as Error).message);
    return null;
  }
  return command;
}

/**
 * Reconstruct all tmux sessions for a user's legacy agent.
 * Called from agentRegistry.registerAgent when a non-instance-bound agent
 * connects.
 */
export async function reconstructUserSessions(userId: string, unixUsername: string): Promise<void> {
  await reconstructAgentSessions(userId, unixUsername, null);
}

/**
 * Reconstruct tmux sessions for one specific box's agent. Called when an
 * instance-bound agent connects (after a box reboot / replacement). Only
 * touches projects pinned to this instance.
 */
export async function reconstructInstanceSessions(
  instanceId: string,
  userId: string,
  unixUsername: string,
): Promise<void> {
  await reconstructAgentSessions(userId, unixUsername, instanceId);
}

/**
 * Reconstruct tmux sessions for one agent. Filters projects so the legacy
 * agent only sees legacy projects (instanceId IS NULL) and an instance
 * agent only sees its own projects (instanceId = X). Avoids cross-talk
 * where one agent would try to recreate sessions belonging to another box.
 */
async function reconstructAgentSessions(
  userId: string,
  unixUsername: string,
  instanceId: string | null,
): Promise<void> {
  // hostHome is read here rather than passed in: registerAgent schedules this
  // 2s after connect while the `hello` that supplies it is a fire-and-forget
  // write, so the freshest value is whatever the DB holds right now.
  const projects = await prisma.project.findMany({
    where: { userId, archived: false, instanceId },
    include: {
      workflows: { include: { workstream: { include: { askThread: { select: { id: true } } } } } },
      instance: { select: { hostHome: true } },
    },
  });

  if (projects.length === 0) return;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  const defaultProvider = user?.defaultAgentProvider ?? 'claude';

  let launched = 0;

  for (const project of projects) {
    const projectHost = { userId, instanceId };
    const unready = refuseUnreadySessions(project);
    if (unready) {
      console.log(`[RECONSTRUCT] Skipping ${project.name}: setup is ${unready.setupStatus}`);
      continue;
    }

    for (const wf of project.workflows) {
      const wsName = wf.workstream.name;
      // An ask's chat has no worktree and no pane (services/askChat.ts).
      if (wf.workstream.askThread) continue;
      try {
        if (wf.type === 'agent') {
          const provider = resolveAgentProvider(wf.provider, defaultProvider);
          const mainSession = tmux.sessionName(unixUsername, project.name, 'agent', wsName);

          const didLaunch = await withPaneLock(paneLockKey(instanceId, mainSession), async (): Promise<boolean> => {
            // A parked spawn stays parked across a reconnect: its CLI was stopped on purpose.
            if (await isParkedSpawn(userId, project.id, wsName)) {
              console.log(`[RECONSTRUCT] Skipping ${project.name}/${wsName}: a parked spawn`);
              return false;
            }
            const probe = await probeAgentSession(projectHost, mainSession);
            if (probe === 'running') {
              const config = PROVIDERS[provider];
              if (config?.needsPoller) registerPollerSession(mainSession, provider);
              return false;
            }
            if (probe === 'unknown') {
              console.warn(`[RECONSTRUCT] Skipping ${project.name}/${wf.type}: probe failed`);
              return false;
            }
            if (probe === 'busy') {
              console.warn(`[RECONSTRUCT] Skipping ${project.name}/${wf.type}: git is in the foreground`);
              return false;
            }

            // Relaunch into an existing cwd: resume the last session there when
            // the provider knows how (claude --continue, pi
            // --continue), else a fresh launch.
            const config = PROVIDERS[provider];

            const projDir = tmux.projectDirFor(
              { name: project.name, user: { unixUsername }, instance: project.instance },
              wsName,
            );
            const ctrlSession = tmux.sessionName(unixUsername, project.name, 'ctrl', wsName);

            await sendForProject(projectHost, 'tmux-create', { sessionName: mainSession, cwd: projDir });
            await sendForProject(projectHost, 'tmux-create', { sessionName: ctrlSession, cwd: projDir });

            await new Promise(resolve => setTimeout(resolve, 500));

            // A chat-runner provider's Claude runs per turn, not in the pane.
            if (config?.chatRunner) return false;

            // A spawned agent whose first launch never typed (pane busy, probe
            // failed, send failed) has no conversation to resume: start it on its
            // brief instead.
            const capabilities = instanceId ? instanceAgentTransport(instanceId)?.capabilities ?? [] : [];
            const spawned = config?.needsBridge ? null : await claimSpawnLaunch({ userId, projectId: project.id, workstream: wsName, provider });
            if (spawned) await trustSpawnFolder(projectHost, { provider, capabilities, project, projDir, label: `${project.name}/${wsName}` });
            // Likewise a pane a handoff restart killed just before the box
            // dropped: resuming would bring back the conversation it handed off.
            const claim = config?.needsBridge || spawned ? null : await claimHandoffLaunch({ userId, projectId: project.id, workstream: wsName, provider });
            if (claim === 'held') {
              console.warn(`[RECONSTRUCT] Skipping ${project.name}/${wsName}: a handoff launch is already starting in this pane`);
              return false;
            }
            const handedOff = claim;
            const on = await resolveLaunch(provider, wf.backend, wf.model, userId, instanceId);
            const launchCmd = on.refusal
              ?? launchCommandFor(spawned?.command ?? handedOff?.command ?? config?.resumeCommand ?? config?.launchCommand ?? provider, { capabilities, provider, project: project.name, workstream: wsName, ...on });

            await watchLaunchedSpawn({ userId, projectId: project.id, workstream: wsName, session: mainSession, instanceId });
            if (config?.needsBridge) {
              await sendForProject(projectHost, 'codex-session-start', { sessionName: mainSession, cwd: projDir, project: project.name, workstream: wsName });
            } else {
              try {
                await sendForProject(projectHost, 'tmux-send-keys', { sessionName: mainSession, keys: launchCmd, withEnter: true });
              } catch (err) {
                if (spawned) await releaseSpawnLaunch(spawned.id);
                if (handedOff) await releaseHandoffLaunch(handedOff.id);
                throw err;
              }
            }

            if (config?.needsPoller) {
              registerPollerSession(mainSession, provider);
            }

            return true;
          }, typed => (typed ? paneLaunchSettleMs : 0));
          if (didLaunch) launched++;
        } else {
          // Data workflow — just ensure sessions exist
          const mainSession = tmux.sessionName(unixUsername, project.name, 'data', wsName);
          const ctrlSession = tmux.sessionName(unixUsername, project.name, 'data-ctrl', wsName);
          const projDir = tmux.projectDirFor(
            { name: project.name, user: { unixUsername }, instance: project.instance },
            wsName,
          );

          await sendForProject(projectHost, 'tmux-create', { sessionName: mainSession, cwd: projDir });
          await sendForProject(projectHost, 'tmux-create', { sessionName: ctrlSession, cwd: projDir });
        }
      } catch (err) {
        console.error(`[RECONSTRUCT] Failed for ${project.name}/${wf.type}:`, (err as Error).message);
      }
    }
  }

  const scope = instanceId ? `instance ${instanceId}` : `${unixUsername} (legacy)`;
  console.log(`[RECONSTRUCT] ${scope}: reconstructed ${launched} agent sessions across ${projects.length} projects`);
}

/**
 * Stop whatever runs in ONE workstream's agent pane, and nothing else: the
 * ctrl shell and the Review pane stay up. Used to switch a workstream to a
 * different agent (routes/workstreams.ts), where killing the session is the
 * only stop that works for every provider — typing `/exit` or C-c means
 * something different to each CLI. Unlike stopAgentSessions this throws when
 * the box refuses, so the caller can undo its own changes.
 */
export async function stopAgentPane({
  userId,
  unixUsername,
  projectName,
  provider,
  instanceId,
  workstream,
}: AgentRuntimeContext): Promise<void> {
  const config = PROVIDERS[provider];
  const mainSession = tmux.sessionName(unixUsername, projectName, 'agent', workstream);
  const project = { userId, instanceId };

  if (isProjectAgentConnected(project)) {
    if (config?.needsBridge) {
      await sendForProject(project, 'codex-session-stop', { sessionName: mainSession }).catch(() => {});
    }
    // exact: a missing session must not let tmux prefix-match a sibling.
    await sendForProject(project, 'tmux-kill', { sessionName: mainSession, exact: true });
  } else if (instanceId) {
    throw new Error('Box agent not connected');
  } else {
    await tmux.killSession(mainSession); // exact-target, like the RPC above
  }
  // Only once the pane is really gone: a stop that throws leaves the old agent
  // running, and it must keep its poller (its only status source) until then.
  if (config?.needsPoller) unregisterPollerSession(mainSession);
}

export async function stopAgentSessions({
  userId,
  unixUsername,
  projectName,
  provider,
  instanceId,
  workstream,
}: AgentRuntimeContext): Promise<void> {
  const config = PROVIDERS[provider];
  const mainSession = tmux.sessionName(unixUsername, projectName, 'agent', workstream);
  const ctrlSession = tmux.sessionName(unixUsername, projectName, 'ctrl', workstream);
  // The Devin review pane (routes/review.ts) hangs off the agent workflow and
  // must die with it, or Devin keeps burning tokens in a pane nobody can see.
  const reviewSession = tmux.sessionName(unixUsername, projectName, 'review', workstream);
  const project = { userId, instanceId };

  if (config?.needsPoller) {
    unregisterPollerSession(mainSession);
  }

  if (isProjectAgentConnected(project)) {
    if (config?.needsBridge) {
      await sendForProject(project, 'codex-session-stop', { sessionName: mainSession }).catch(() => {});
    }
    await sendForProject(project, 'tmux-kill', { sessionName: mainSession }).catch(() => {});
    await sendForProject(project, 'tmux-kill', { sessionName: ctrlSession }).catch(() => {});
    await sendForProject(project, 'tmux-kill', { sessionName: reviewSession }).catch(() => {});
    return;
  }

  // Box-hosted projects with no live agent — nothing we can do; sessions die
  // with the box. Legacy projects fall through to the orchestrator's local
  // tmux (the original behavior).
  if (instanceId) return;

  await tmux.killSession(mainSession);
  await tmux.killSession(ctrlSession);
  await tmux.killSession(reviewSession);
}
