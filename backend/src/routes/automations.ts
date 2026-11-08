/**
 * Automations: a project whose prompt a fresh agent
 * runs on a cron schedule, each run a workstream and one chat-runner turn.
 *
 *   POST /api/automations                       create (project kind automation + the row)
 *   POST /api/automations/preview               a schedule's next occurrences, in words before Save
 *   GET  /api/automations                       mine and shared with me
 *   GET  /api/automations/:id                   one, with its last 50 runs (:id is the automation's or its project's id)
 *   PATCH /api/automations/:id                  schedule, prompt, tier, enabled, space and folder, backend and model, …; clears a pause
 *   POST /api/automations/:id/run               a manual occurrence now (202)
 *   POST /api/automations/:id/runs/:runId/stop  interrupt a live run
 *   POST /api/automations/:id/runs/:runId/retire remove a finished run's worktree (:runId: the run's id or its workstream's)
 *   GET  /api/automations/:id/memory            the runs' notes file (owner)
 *   DELETE /api/automations/:id                 archive the project; the rows stay
 *
 * Everything but GET is owner-only and behind automations-enabled, read for
 * the owner and the box (403 automations_disabled). The run's conversation is
 * the project's chat routes (routes/chat.ts) with the run's workstream.
 */
import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { CHAT_PROVIDER_ID } from '../providers/registry';
import { sendForProject } from '../services/agentRegistry';
import { AUTOMATIONS_FLAG, NOTES_PUSH_DELAY_MS, decideAndStart } from '../services/automations/scheduler';
import { settleInterruptedRun } from '../services/automations/complete';
import { isRunTier } from '../services/automations/brief';
import { automationLimitsFor, type AutomationLimits } from '../services/automations/limits';
import { estimateMinutesPerDay, minGapMinutes, nextOccurrence, nextOccurrences, occurrenceMinute, parseSchedule, parseTimezone } from '../services/automations/schedule';
import { automationFor, automationView, automationsFor, runsFor, type AutomationRow } from '../services/automations/store';
import { chatKeyFor } from '../services/chatRunner';
import { fireworksOfferedTo } from '../services/fireworksFlag';
import { mainAgentRow, namesModelChoice, parseModelChoice } from '../services/automations/model';
import { memoryDir } from '../services/automations/runner';
import { SPACE_FOLDER_FLAG, SYNC_REFUSAL_TEXT, checkSpaceForOwner, publishReadmeFor } from '../services/automations/spaceSync';
import { chosenFolderRefusal, spaceFolderFor } from '../services/automations/spaceFolder';
import { boolVariation } from '../services/featureFlags';
import { isReservedProjectName, RESERVED_NAME_ERROR } from './projectNames';
import { archiveOwnedProject, createProjectFor } from './projects';
import { RouteResult, sendResult } from './routeResult';
import { removeWorkstreamFor } from './workstreams';
import { forgetT3Hook, parseT3Fields, saveT3Hook, T3_AUTOMATION_KIND, t3HookStoreReady, T3HookStoreUnavailable } from '../services/automations/t3Hook';

const MAX_PROMPT = 20_000;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

interface ScheduleFields { schedule: string; timezone: string }

function parseScheduleFields(body: Record<string, unknown>, limits: AutomationLimits): Parsed<ScheduleFields> {
  const s = parseSchedule(body.schedule);
  if (!s.ok) return { ok: false, error: s.error };
  const tz = parseTimezone(body.timezone);
  if (!tz.ok) return { ok: false, error: tz.error };
  const gap = minGapMinutes(s.schedule, tz.timezone);
  if (gap < limits.minIntervalMinutes) return { ok: false, error: `schedule runs every ${gap} minutes; the minimum is ${limits.minIntervalMinutes}` };
  if (!nextOccurrence(s.schedule, tz.timezone, new Date())) return { ok: false, error: 'schedule never runs again' };
  return { ok: true, value: { schedule: s.schedule, timezone: tz.timezone } };
}

interface Settings {
  prompt?: string; tier?: string; enabled?: boolean; prOnChange?: boolean; wakeBox?: boolean; notifySlack?: boolean; maxRunMinutes?: number; keepRuns?: number; spaceName?: string | null;
}

/** The optional settings a create or PATCH may carry, validated; absent keys stay absent. */
function parseSettings(body: Record<string, unknown>, limits: AutomationLimits, requirePrompt: boolean): Parsed<Settings> {
  const out: Settings = {};
  if (body.prompt !== undefined || requirePrompt) {
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) return { ok: false, error: 'prompt is required' };
    if (body.prompt.length > MAX_PROMPT) return { ok: false, error: `prompt is longer than ${MAX_PROMPT} characters` };
    out.prompt = body.prompt;
  }
  if (body.tier !== undefined) {
    if (!isRunTier(body.tier)) return { ok: false, error: 'tier must be full or read' };
    out.tier = body.tier;
  }
  for (const k of ['enabled', 'prOnChange', 'wakeBox', 'notifySlack'] as const) {
    if (body[k] !== undefined) {
      if (typeof body[k] !== 'boolean') return { ok: false, error: `${k} must be true or false` };
      out[k] = body[k] as boolean;
    }
  }
  if (body.maxRunMinutes !== undefined) {
    const v = body.maxRunMinutes;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > limits.maxRunMinutes) return { ok: false, error: `maxRunMinutes must be 1 to ${limits.maxRunMinutes}` };
    out.maxRunMinutes = v;
  }
  if (body.keepRuns !== undefined) {
    const v = body.keepRuns;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > limits.keepRunsMax) return { ok: false, error: `keepRuns must be 1 to ${limits.keepRunsMax}` };
    out.keepRuns = v;
  }
  if (body.spaceName !== undefined) {
    if (body.spaceName !== null && (typeof body.spaceName !== 'string' || !/^[a-z0-9-]{2,40}$/.test(body.spaceName))) return { ok: false, error: 'spaceName must be a space name or null' };
    out.spaceName = body.spaceName as string | null;
  }
  return { ok: true, value: out };
}

async function flagFor(user: Express.User, instanceId: string | null): Promise<boolean> {
  const box = instanceId ? await prisma.instance.findUnique({ where: { id: instanceId }, select: { id: true, name: true, kind: true } }) : null;
  return boolVariation(AUTOMATIONS_FLAG, user, false, box);
}

/**
 * The folder is fixed (spaceFolder.ts): a body naming another is a 400, not
 * ignored, so a caller never believes its folder was used. The fixed one
 * itself goes through, so a client that sends the view back can still save.
 */
function folderRefused(raw: unknown, fixed: string | null): RouteResult | null {
  const error = chosenFolderRefusal(raw, fixed);
  return error ? { status: 400, body: { error, code: 'space_folder_fixed' } } : null;
}

const disabled: RouteResult = { status: 403, body: { error: 'Automations are not enabled for you on this box', code: 'automations_disabled' } };

export async function createAutomationFor(user: Express.User, raw: unknown): Promise<RouteResult> {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { status: 400, body: { error: 'name required' } };
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return { status: 400, body: { error: 'name must be alphanumeric with dashes/underscores only' } };
  if (isReservedProjectName(name)) return { status: 400, body: { error: RESERVED_NAME_ERROR } };
  const instanceId = typeof body.instanceId === 'string' ? body.instanceId : null;
  if (!instanceId) return { status: 400, body: { error: 'An automation runs on a box: instanceId is required' } };
  const box = await prisma.instance.findFirst({ where: { id: instanceId, userId: user.id }, select: { id: true, name: true, kind: true } });
  if (!box) return { status: 400, body: { error: 'instanceId not found or not owned by you' } };
  if (!(await boolVariation(AUTOMATIONS_FLAG, user, false, box))) return disabled;
  const limits = await automationLimitsFor(user, box);
  const enabledCount = await prisma.automation.count({ where: { userId: user.id, enabled: true, project: { archived: false } } });
  if (enabledCount >= limits.maxEnabledPerUser && body.enabled !== false) {
    return { status: 429, body: { error: `you already have ${enabledCount} automations enabled (limit ${limits.maxEnabledPerUser}); disable one first`, code: 'automation_limit' } };
  }
  const sched = parseScheduleFields(body, limits);
  if (!sched.ok) return { status: 400, body: { error: sched.error } };
  const settings = parseSettings(body, limits, true);
  if (!settings.ok) return { status: 400, body: { error: settings.error } };
  if (settings.value.spaceName) {
    const space = await checkSpaceForOwner(user.id, settings.value.spaceName);
    if (!space.ok) return { status: 400, body: { error: SYNC_REFUSAL_TEXT[space.reason], code: space.reason } };
  }
  // The folder is .termag/automations/<id> (decision 13): no id yet, so no folder can match it.
  const refused = folderRefused(body.spaceFolder, null);
  if (refused) return refused;
  const tier = settings.value.tier ?? 'full';
  // A t3 automation runs a T3 Code scheduled task on its box (services/automations/t3Hook.ts).
  const kind = body.kind === undefined || body.kind === 'chat' ? 'chat' : body.kind === T3_AUTOMATION_KIND ? T3_AUTOMATION_KIND : null;
  if (!kind) return { status: 400, body: { error: 'kind is chat or t3' } };
  const t3 = kind === T3_AUTOMATION_KIND ? parseT3Fields(body.t3) : null;
  if (t3 && !t3.ok) return { status: 400, body: { error: t3.error } };
  // Before anything is made: with no store the webhook couldn't be kept, and a
  // project archived behind the refusal would block the name on a retry.
  if (t3 && !t3HookStoreReady()) {
    return { status: 503, body: { error: "This termag has no credential store, so it cannot keep a T3 task's webhook", code: 'credential_store_off' } };
  }
  if (body.repoUrl !== undefined && body.repoUrl !== null && typeof body.repoUrl !== 'string') return { status: 400, body: { error: 'repoUrl must be a string' } };
  if (body.defaultBranch !== undefined && body.defaultBranch !== null && typeof body.defaultBranch !== 'string') return { status: 400, body: { error: 'defaultBranch must be a string' } };

  // createProjectFor un-archives an archived project of the same name when
  // no repoUrl is given (routes/projects.ts), answering 200 with that
  // project: an automation needs its own fresh project, so a same-named
  // archived one is a conflict here, whatever box it lived on.
  const archivedTwin = await prisma.project.findFirst({ where: { userId: user.id, name, archived: true }, select: { id: true } });
  if (archivedTwin) return { status: 409, body: { error: `An archived project named ${name} exists; pick another name`, code: 'archived_name' } };

  // The project, made as the simple UI makes a chat project: Claude in the
  // chat runner, so main runs no agent process and the clone goes the way a
  // chat project's does. A full-tier automation is the owner's trust tick.
  const created = await createProjectFor(user, {
    name, instanceId,
    repoUrl: (body.repoUrl as string | null | undefined) ?? null,
    defaultBranch: (body.defaultBranch as string | null | undefined) ?? null,
    // A Fireworks model rides on the agent row, as a chat's does; createProjectFor checks it.
    initialAgent: {
      enabled: true, provider: CHAT_PROVIDER_ID,
      ...(body.backend === 'fireworks' ? { backend: 'fireworks', model: typeof body.model === 'string' ? body.model : null } : {}),
    },
    chatTrusted: tier === 'full',
    kind: 'automation',
    claudeModel: typeof body.claudeModel === 'string' || body.claudeModel === null ? body.claudeModel : undefined,
    replaySessionId: typeof body.replaySessionId === 'string' ? body.replaySessionId : null,
  });
  if (created.status !== 201) {
    // 200 is an un-archive (a project made between the check above and this call): not ours to adopt.
    if (created.status === 200) return { status: 409, body: { error: `An archived project named ${name} exists; pick another name`, code: 'archived_name' } };
    return created;
  }
  const project = created.body as { id: string };
  const now = new Date();
  let automation;
  try {
    automation = await prisma.automation.create({
      data: {
        projectId: project.id, userId: user.id,
        schedule: sched.value.schedule, timezone: sched.value.timezone, prompt: settings.value.prompt!,
        kind, t3TaskId: t3?.ok ? t3.value.taskId : null,
        tier, enabled: settings.value.enabled ?? true, prOnChange: settings.value.prOnChange ?? true,
        wakeBox: settings.value.wakeBox ?? false, notifySlack: settings.value.notifySlack ?? false,
        maxRunMinutes: Math.min(settings.value.maxRunMinutes ?? 60, limits.maxRunMinutes),
        keepRuns: settings.value.keepRuns ?? 20, spaceName: settings.value.spaceName ?? null,
        nextRunAt: nextOccurrence(sched.value.schedule, sched.value.timezone, now), lastOccurrence: now,
      },
      include: { project: { select: { name: true, instanceId: true, repoUrl: true, repoDefaultBranch: true, archived: true, userId: true } } },
    });
  } catch (err) {
    // The project exists with no automation behind it: archive it so it does
    // not sit in the sidebar as a chat project nobody asked for.
    await archiveOwnedProject(user, project.id).catch(() => {});
    throw err;
  }
  if (t3?.ok) {
    try {
      await saveT3Hook(user.id, automation.id, t3.value.hookPath);
    } catch (err) {
      // No webhook kept, no automation: it could never run.
      await prisma.automation.delete({ where: { id: automation.id } }).catch(() => {});
      await archiveOwnedProject(user, project.id).catch(() => {});
      if (err instanceof T3HookStoreUnavailable) return { status: 503, body: { error: err.message, code: 'credential_store_off' } };
      throw err;
    }
  }
  // The folder is derived from the id, which the row has only now.
  if (automation.spaceName) {
    automation = await prisma.automation.update({ where: { id: automation.id }, data: { spaceFolder: spaceFolderFor(automation.id) }, include: { project: { select: { name: true, instanceId: true, repoUrl: true, repoDefaultBranch: true, archived: true, userId: true } } } });
  }
  console.log(`[AUTOMATION] ${user.unixUsername} created ${name} (${sched.value.schedule} ${sched.value.timezone}, ${tier})`);
  if (automation.spaceName && await boolVariation(SPACE_FOLDER_FLAG, user, false)) void publishReadmeFor(automation.id);
  return { status: 201, body: { project: created.body, automation: await automationView(automation as AutomationRow, user.id, now), next: nextOccurrences(sched.value.schedule, sched.value.timezone, now, 3).map(d => d.toISOString()) } };
}

export async function previewScheduleFor(user: Express.User, raw: unknown): Promise<RouteResult> {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const limits = await automationLimitsFor(user, null);
  const s = parseSchedule(body.schedule);
  if (!s.ok) return { status: 400, body: { error: s.error } };
  const tz = parseTimezone(body.timezone);
  if (!tz.ok) return { status: 400, body: { error: tz.error } };
  const now = new Date();
  const gap = minGapMinutes(s.schedule, tz.timezone, now);
  const runMinutes = typeof body.maxRunMinutes === 'number' && body.maxRunMinutes > 0 ? Math.min(body.maxRunMinutes, limits.maxRunMinutes) : 60;
  return {
    status: 200,
    body: {
      normalised: s.schedule,
      timezone: tz.timezone,
      next: nextOccurrences(s.schedule, tz.timezone, now, 5).map(d => d.toISOString()),
      minGapMinutes: Number.isFinite(gap) ? gap : null,
      tooFrequent: gap < limits.minIntervalMinutes ? limits.minIntervalMinutes : null,
      keepsBoxUpMinutesPerDay: body.wakeBox === true ? estimateMinutesPerDay(s.schedule, tz.timezone, runMinutes, now) : null,
    },
  };
}

export async function listAutomationsFor(user: Express.User): Promise<RouteResult> {
  const rows = await automationsFor(user.id);
  const now = new Date();
  return { status: 200, body: await Promise.all(rows.map(r => automationView(r, user.id, now))) };
}

export async function automationDetailFor(user: Express.User, id: string): Promise<RouteResult> {
  const a = await automationFor(user.id, id);
  if (!a) return { status: 404, body: { error: 'Automation not found' } };
  return { status: 200, body: { ...(await automationView(a, user.id)), runs: await runsFor(a.id) } };
}

async function owned(user: Express.User, id: string): Promise<AutomationRow | RouteResult> {
  const a = await automationFor(user.id, id);
  if (!a) return { status: 404, body: { error: 'Automation not found' } };
  if (a.userId !== user.id) return { status: 403, body: { error: "Only the automation's owner can change it" } };
  return a;
}
const isResult = (x: AutomationRow | RouteResult): x is RouteResult => 'status' in x && 'body' in x;

/** Deleting archives the project; the scheduler treats it as gone, so changing it or running it by hand is refused too. */
const archivedResult: RouteResult = { status: 409, body: { error: 'This automation is archived', code: 'automation_archived' } };

export async function updateAutomationFor(user: Express.User, id: string, raw: unknown): Promise<RouteResult> {
  const a = await owned(user, id);
  if (isResult(a)) return a;
  if (a.project.archived) return archivedResult;
  if (!(await flagFor(user, a.project.instanceId))) return disabled;
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const box = a.project.instanceId ? await prisma.instance.findUnique({ where: { id: a.project.instanceId }, select: { id: true, name: true, kind: true } }) : null;
  const limits = await automationLimitsFor(user, box);
  const data: Record<string, unknown> = {};
  if (body.schedule !== undefined || body.timezone !== undefined) {
    const sched = parseScheduleFields({ schedule: body.schedule ?? a.schedule, timezone: body.timezone ?? a.timezone }, limits);
    if (!sched.ok) return { status: 400, body: { error: sched.error } };
    data.schedule = sched.value.schedule;
    data.timezone = sched.value.timezone;
  }
  const settings = parseSettings(body, limits, false);
  if (!settings.ok) return { status: 400, body: { error: settings.error } };
  const rest = settings.value;
  const folders = await boolVariation(SPACE_FOLDER_FLAG, user, false);
  // The fixed folder, or the one the row still has from before it (until the move script moves it).
  const refused = folderRefused(body.spaceFolder, a.spaceFolder ?? spaceFolderFor(a.id));
  if (refused) return refused;
  const nextSpace = rest.spaceName !== undefined ? rest.spaceName : a.spaceName;
  const spaceChanged = !!nextSpace && nextSpace !== a.spaceName;
  // A space is checked when it is chosen, not on every save that carries the
  // same name back: once the owner loses write access to it, they could
  // otherwise save nothing until the mirror was cleared.
  if (spaceChanged) {
    const space = await checkSpaceForOwner(user.id, nextSpace!, a.projectId);
    if (!space.ok) return { status: 400, body: { error: SYNC_REFUSAL_TEXT[space.reason], code: space.reason } };
  }
  // The model the next run starts on lives on main's agent row (services/automations/model.ts); a run already made keeps its own.
  let agentChange: { id: string; backend: string | null; model: string | null } | null = null;
  if (namesModelChoice(body)) {
    const agent = await mainAgentRow(a.projectId);
    if (!agent?.provider) return { status: 409, body: { error: 'This automation has no agent to change the model of', code: 'no_agent' } };
    const fireworks = body.backend === 'fireworks' ? await fireworksOfferedTo(user) : null;
    const choice = parseModelChoice(body, agent.provider, fireworks);
    if (!choice.ok) return { status: 400, body: { error: choice.error } };
    if (choice.choice.backend === 'fireworks' && !a.project.instanceId) return { status: 400, body: { error: 'Fireworks models run only on a box' } };
    if (choice.choice.backend !== agent.backend || choice.choice.model !== agent.model) agentChange = { id: agent.id, ...choice.choice };
  }
  Object.assign(data, rest);
  // A t3 automation's task, or its webhook after a rotation, saved again from the desktop.
  if (body.t3 !== undefined) {
    if (a.kind !== T3_AUTOMATION_KIND) return { status: 400, body: { error: 't3 is only for an automation that runs a T3 task' } };
    const t3 = parseT3Fields(body.t3);
    if (!t3.ok) return { status: 400, body: { error: t3.error } };
    try {
      await saveT3Hook(user.id, a.id, t3.value.hookPath);
    } catch (err) {
      if (err instanceof T3HookStoreUnavailable) return { status: 503, body: { error: err.message, code: 'credential_store_off' } };
      throw err;
    }
    data.t3TaskId = t3.value.taskId;
  }
  // Attaching a space, or another one, puts the automation in its fixed folder there; detaching keeps the column.
  if (spaceChanged) data.spaceFolder = spaceFolderFor(a.id);
  if (rest.enabled === true && !a.enabled) {
    const enabledCount = await prisma.automation.count({ where: { userId: user.id, enabled: true, project: { archived: false } } });
    if (enabledCount >= limits.maxEnabledPerUser) return { status: 429, body: { error: `you already have ${enabledCount} automations enabled (limit ${limits.maxEnabledPerUser})`, code: 'automation_limit' } };
  }
  if (rest.tier === 'full' && !a.project.archived) {
    await prisma.project.updateMany({ where: { id: a.projectId, chatTrustedAt: null }, data: { chatTrustedAt: new Date() } });
  }
  if (agentChange) {
    await prisma.workflow.update({ where: { id: agentChange.id }, data: { backend: agentChange.backend, model: agentChange.model } });
    console.log(`[AUTOMATION] ${user.unixUsername} ${a.project.name}: next runs on ${agentChange.backend ?? 'default'} ${agentChange.model ?? '(default model)'}`);
  }
  const now = new Date();
  const schedule = (data.schedule as string | undefined) ?? a.schedule;
  const timezone = (data.timezone as string | undefined) ?? a.timezone;
  // Any save clears a pause and restarts the clock: occurrences before now are not owed.
  const updated = await prisma.automation.update({
    where: { id: a.id },
    data: { ...data, pausedReason: null, consecutiveFailures: 0, nextRunAt: nextOccurrence(schedule, timezone, now), lastOccurrence: now },
    include: { project: { select: { name: true, instanceId: true, repoUrl: true, repoDefaultBranch: true, archived: true, userId: true } } },
  });
  // The README says what the automation is: a save may have changed that.
  if (folders && updated.spaceName) void publishReadmeFor(updated.id);
  return { status: 200, body: await automationView(updated as AutomationRow, user.id, now) };
}

export async function runNowFor(user: Express.User, id: string): Promise<RouteResult> {
  const a = await owned(user, id);
  if (isResult(a)) return a;
  if (a.project.archived) return archivedResult;
  if (!(await flagFor(user, a.project.instanceId))) return disabled;
  const full = await prisma.automation.findUnique({ where: { id: a.id }, include: { project: { include: { user: { select: { id: true, unixUsername: true, googleEmail: true, displayName: true, defaultAgentProvider: true } }, instance: true } } } });
  if (!full) return { status: 404, body: { error: 'Automation not found' } };
  const now = new Date();
  let run;
  try {
    run = await prisma.automationRun.create({ data: { automationId: a.id, trigger: 'manual', scheduledFor: occurrenceMinute(now), state: 'pending' } });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return { status: 409, body: { error: 'A manual run was already started this minute' } };
    throw err;
  }
  const box = full.project.instance ? { id: full.project.instance.id, name: full.project.instance.name, kind: full.project.instance.kind } : null;
  const limits = await automationLimitsFor(user, box);
  // A paused automation still runs by hand: the click is the owner saying go.
  const decision = await decideAndStart({ ...full, pausedReason: null }, run.id, limits, now);
  const row = await prisma.automationRun.findUnique({ where: { id: run.id }, include: { workstream: { select: { name: true } } } });
  const { runView } = await import('../services/automations/store');
  const view = row ? runView(row, now) : null;
  // Skipped is the owner's situation (409, with why); a start that failed on the box is the box's (502).
  if (decision.kind === 'skip') return { status: 409, body: { run: view, decision } };
  if (decision.kind === 'failed') return { status: 502, body: { error: `the run could not start: ${decision.error}`, run: view, decision } };
  return { status: 202, body: { run: view, decision } };
}

export async function stopRunFor(user: Express.User, id: string, runId: string): Promise<RouteResult> {
  const a = await owned(user, id);
  if (isResult(a)) return a;
  let run = await prisma.automationRun.findFirst({ where: { id: runId, automationId: a.id }, include: { workstream: { select: { id: true } } } });
  if (!run) return { status: 404, body: { error: 'Run not found' } };
  if (run.state === 'pending') {
    const skipped = await prisma.automationRun.updateMany({ where: { id: run.id, state: 'pending' }, data: { state: 'skipped', reason: 'interrupted', finishedAt: new Date() } });
    if (skipped.count > 0) return { status: 200, body: { ok: true } };
    // The scheduler claimed it between the read and this write: stop what it is now.
    run = await prisma.automationRun.findFirst({ where: { id: runId, automationId: a.id }, include: { workstream: { select: { id: true } } } });
    if (!run) return { status: 404, body: { error: 'Run not found' } };
  }
  if (run.state !== 'running') return { status: 409, body: { error: 'This run is not live' } };
  // The row first, then the interrupt: the turn-end the interrupt causes
  // would otherwise race this write (services/automations/scheduler.ts timeOutRuns).
  const stopped = await prisma.automationRun.updateMany({ where: { id: run.id, state: 'running' }, data: { state: 'failed', reason: 'interrupted', finishedAt: new Date() } });
  if (stopped.count === 0) return { status: 409, body: { error: 'This run is not live' } };
  if (run.workstream && a.project.instanceId) {
    await sendForProject({ userId: a.userId, instanceId: a.project.instanceId }, 'chat-interrupt', { chatKey: chatKeyFor(a.projectId, run.workstream.id) }, 10_000)
      .catch(err => console.warn(`[AUTOMATION] ${a.project.name}: interrupt failed: ${(err as Error).message}`));
  }
  // Stop owns the run's end: its notes push takes its place in the queue now,
  // ahead of any later run's pull, and the push and the branch summary and
  // report happen once the interrupt has stopped the turn's writes
  // (complete.ts settleInterruptedRun), not from the tree as it is mid-turn.
  await settleInterruptedRun(run.id, NOTES_PUSH_DELAY_MS);
  return { status: 200, body: { ok: true } };
}

export async function retireRunFor(user: Express.User, id: string, runId: string): Promise<RouteResult> {
  const a = await owned(user, id);
  if (isResult(a)) return a;
  // :runId is the run's id, or its workstream's (the sidebar knows a run by its worktree, and its list of runs is finite).
  const run = await prisma.automationRun.findFirst({ where: { automationId: a.id, OR: [{ id: runId }, { workstreamId: runId }] } });
  if (!run) return { status: 404, body: { error: 'Run not found' } };
  if (run.state === 'running' || run.state === 'pending') return { status: 409, body: { error: 'Stop the run first' } };
  if (!run.workstreamId) return { status: 200, body: { ok: true, already: true } };
  const result = await removeWorkstreamFor(user, a.projectId, run.workstreamId, { force: false });
  if (result.status >= 300 && result.status !== 404) return result;
  await prisma.automationRun.update({ where: { id: run.id }, data: { retiredAt: new Date(), workstreamId: null } });
  return { status: 200, body: { ok: true } };
}

/** The notes file the runs share, read off the box. Owner only: it may hold anything a run wrote. */
export async function memoryFor(user: Express.User, id: string): Promise<RouteResult> {
  const a = await owned(user, id);
  if (isResult(a)) return a;
  if (!a.project.instanceId) return { status: 400, body: { error: 'This automation has no box' } };
  const box = await prisma.instance.findUnique({ where: { id: a.project.instanceId }, select: { hostHome: true } });
  const path = `${memoryDir(box?.hostHome ?? `/home/${user.unixUsername}`, a.projectId)}/MEMORY.md`;
  try {
    const got = await sendForProject({ userId: a.userId, instanceId: a.project.instanceId }, 'read-file', { path }, 10_000) as { content?: unknown };
    return { status: 200, body: { path, content: typeof got?.content === 'string' ? got.content.slice(0, 200_000) : null } };
  } catch (err) {
    const message = (err as Error).message;
    if (/ENOENT|no such file/i.test(message)) return { status: 200, body: { path, content: null } };
    return { status: 503, body: { error: `Could not read the notes file: ${message}`, path } };
  }
}

export async function deleteAutomationFor(user: Express.User, id: string): Promise<RouteResult> {
  const a = await owned(user, id);
  if (isResult(a)) return a;
  const archived = await archiveOwnedProject(user, a.projectId);
  // Its webhook can start the T3 task on the box: an archived automation keeps none.
  if (a.kind === T3_AUTOMATION_KIND && archived.status < 300) await forgetT3Hook(user.id, a.id).catch(() => {});
  return archived;
}

export function automationsRouter(): Router {
  const router = Router();
  router.get('/', requireAuth, asyncHandler(async (req, res) => sendResult(res, await listAutomationsFor(req.user!))));
  router.post('/', requireAuth, asyncHandler(async (req, res) => sendResult(res, await createAutomationFor(req.user!, req.body))));
  router.post('/preview', requireAuth, asyncHandler(async (req, res) => sendResult(res, await previewScheduleFor(req.user!, req.body))));
  router.get('/:id', requireAuth, asyncHandler(async (req, res) => sendResult(res, await automationDetailFor(req.user!, req.params.id))));
  router.patch('/:id', requireAuth, asyncHandler(async (req, res) => sendResult(res, await updateAutomationFor(req.user!, req.params.id, req.body))));
  router.post('/:id/run', requireAuth, asyncHandler(async (req, res) => sendResult(res, await runNowFor(req.user!, req.params.id))));
  router.post('/:id/runs/:runId/stop', requireAuth, asyncHandler(async (req, res) => sendResult(res, await stopRunFor(req.user!, req.params.id, req.params.runId))));
  router.post('/:id/runs/:runId/retire', requireAuth, asyncHandler(async (req, res) => sendResult(res, await retireRunFor(req.user!, req.params.id, req.params.runId))));
  router.get('/:id/memory', requireAuth, asyncHandler(async (req, res) => sendResult(res, await memoryFor(req.user!, req.params.id))));
  router.delete('/:id', requireAuth, asyncHandler(async (req, res) => sendResult(res, await deleteAutomationFor(req.user!, req.params.id))));
  return router;
}
