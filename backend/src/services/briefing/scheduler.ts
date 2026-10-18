/**
 * Scheduled briefings. Leader work: started and
 * stopped with the other sweeps in index.ts, so two overlapping orchestrator
 * processes never both fire; the unique scheduleKey makes even that harmless.
 *
 * Opt-in only: users whose briefingSchedule is on, nobody else.
 */
import { prisma } from '../../db';
import { readSchedule, scheduleDue, scheduleKey } from './schedule';
import { startBriefing, sweepStuckRuns } from './runner';
import { deliverBriefingDm, undeliveredDms } from './slack';

const TICK_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let ticking = false;

export interface TickDeps {
  enabledUsers: () => Promise<Array<{ id: string; briefingSchedule: unknown }>>;
  existing: (key: string) => Promise<{ id: string; status: string } | null>;
  dropSkipped: (id: string) => Promise<boolean>;
  start: typeof startBriefing;
  deliver: (id: string) => Promise<void>;
  undelivered: (now: Date) => Promise<string[]>;
  sweep: (now: Date) => Promise<number>;
}

const defaultDeps: TickDeps = {
  enabledUsers: () => prisma.user.findMany({
    where: { briefingSchedule: { path: ['enabled'], equals: true } },
    select: { id: true, briefingSchedule: true },
  }),
  existing: key => prisma.briefing.findUnique({ where: { scheduleKey: key }, select: { id: true, status: true } }),
  dropSkipped: async id => (await prisma.briefing.deleteMany({ where: { id, status: 'skipped' } })).count === 1,
  start: startBriefing,
  deliver: deliverBriefingDm,
  undelivered: undeliveredDms,
  sweep: sweepStuckRuns,
};

/** One pass: time out stuck runs, retry DMs that did not go out, then start every due, not-yet-done scheduled briefing. */
export async function schedulerTick(now: Date = new Date(), deps: TickDeps = defaultDeps): Promise<{ started: number }> {
  await deps.sweep(now).catch(err => console.error('[BRIEFING] stuck-run sweep failed:', (err as Error).message));
  for (const id of await deps.undelivered(now).catch(() => [] as string[])) {
    await deps.deliver(id).catch(err => console.error(`[BRIEFING] ${id}: Slack retry failed:`, (err as Error).message));
  }
  let started = 0;
  for (const u of await deps.enabledUsers()) {
    const s = readSchedule(u.briefingSchedule);
    const due = scheduleDue(s, now);
    if (!due.due) continue;
    const key = scheduleKey(u.id, due.day);
    const prior = await deps.existing(key);
    // One scheduled briefing per local day. A skipped one (no box was ready)
    // is retried each tick until the day ends; anything else stands.
    if (prior && prior.status !== 'skipped') continue;
    if (prior && !(await deps.dropSkipped(prior.id))) continue;
    try {
      const out = await deps.start({ user: { id: u.id }, trigger: 'schedule', tz: s.timezone!, deliverSlack: s.slackDm, scheduleKey: key, now });
      if (out.kind === 'started') started++;
      // A skip is not DMed: it is retried every tick until the day ends. A
      // launch that failed outright is reported at once.
      if (out.kind === 'failed' && s.slackDm) void deps.deliver(out.id).catch(() => {});
    } catch (err) {
      console.error(`[BRIEFING] scheduled run for ${u.id} failed to start:`, (err as Error).message);
    }
  }
  return { started };
}

export function startBriefingScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    schedulerTick().catch(err => console.error('[BRIEFING] scheduler tick failed:', (err as Error).message))
      .finally(() => { ticking = false; });
  }, TICK_MS);
  timer.unref?.();
}

export function stopBriefingScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
