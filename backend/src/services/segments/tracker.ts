/**
 * Segment tracker: recomputes each user's daily
 * engagement-ladder segment into user_segment_daily and keeps it current.
 *
 * Signals per user-day (the same definition the offline study uses,
 * termag-user-engagement/SEGMENTS.md): agent working time on their sessions
 * (>= 5 min/day), human typing time, agent token usage — any of the three
 * marks the day active. Creation volumes (claimed boxes; projects +
 * workstreams) feed the Power booster. Warm-pool instances (userId NULL) are
 * not creator actions. Identity: tmux session names sanitize unix usernames
 * (dots/dashes/underscores collapse), so the work-time join normalizes.
 *
 * Cadence: a cheap status check every 10 min; a rebuild when today's rows are
 * missing (or when kicked). A rebuild always recomputes from each user's
 * createdAt — the window is small today and the rows are tiny; prune nothing.
 */
import { prisma } from'../../db';
import { segmentFor, isActiveDay, type Segment } from './rules';
import { isoToday } from './dateutil';

export interface TrackerStatus {
  state: 'idle' | 'running' | 'error';
  lastRunAt: string | null;
  lastRebuiltDay: string | null;
  lastError: string | null;
}

const status = {
  state: 'idle' as TrackerStatus['state'],
  lastRunAt: null as string | null,
  lastRebuiltDay: null as string | null,
  lastError: null as string | null,
};
let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<void> | null = null;

export function segmentTrackerStatus(): TrackerStatus {
  return { ...status };
}

/** Run a rebuild now (used by the boot backfill and ops). */
export function kickSegmentTracker(): void {
  void runRebuild();
}

// The "creation" and "signal" data keyed per user/day, in one shape for
// computeForUser. Numbers are accumulated in SQL so the reunion stays O(rows).
/** The user-day signal union: work time (>=5min agent / any human) or tokens. */
async function loadUserDays(): Promise<Map<string, Map<string, {
  agentMs: number; humanMs: number; tokenRows: number; visited: boolean,
}>>> {
  const rows = await prisma.$queryRaw<Array<{ user_id: string; day: string; agent_ms: number; human_ms: number; token_rows: number; visited: boolean }>>`
    WITH wt AS (
      SELECT u.id AS user_id, we.date AS day,
             COALESCE(SUM(we."totalMs") FILTER (WHERE we.provider <> 'human'), 0) AS agent_ms,
             COALESCE(SUM(we."totalMs") FILTER (WHERE we.provider = 'human'), 0)  AS human_ms,
             count(*) AS token_rows, false AS visited
      FROM work_time_entries we
      JOIN users u
        ON lower(translate(replace(replace(u."unixUsername", '.', '_'), '-', '_'), ' ', '_'))
         = lower(translate(replace(replace(we.username, '.', '_'), '-', '_'), ' ', '_'))
      GROUP BY 1, 2
    ),
    tk AS (
      SELECT tu."userId" AS user_id, tu.date AS day, count(*) AS token_rows
      FROM token_usage_days tu GROUP BY 1, 2
    ),
    vs AS (
      SELECT pv."userId" AS user_id, to_char(pv.timestamp, 'YYYY-MM-DD') AS day, true AS visited
      FROM project_visits pv GROUP BY 1, 2
    )
    SELECT COALESCE(wt.user_id, tk.user_id, vs.user_id) AS user_id,
           COALESCE(wt.day, tk.day, vs.day) AS day,
           COALESCE(wt.agent_ms, 0)  AS agent_ms,
           COALESCE(wt.human_ms, 0)  AS human_ms,
           COALESCE(tk.token_rows, 0) AS token_rows,
           COALESCE(vs.visited, false) AS visited
    FROM wt
    FULL JOIN tk ON tk.user_id = wt.user_id AND tk.day = wt.day
    FULL JOIN vs ON vs.user_id = COALESCE(wt.user_id, tk.user_id)
                AND vs.day = COALESCE(wt.day, tk.day)
  `;
  const out = new Map<string, Map<string, { agentMs: number; humanMs: number; tokenRows: number; visited: boolean }>>();
  for (const r of rows) {
    let m = out.get(r.user_id);
    if (!m) out.set(r.user_id, m = new Map());
    m.set(r.day, {
      agentMs: Number(r.agent_ms), humanMs: Number(r.human_ms),
      tokenRows: Number(r.token_rows), visited: Boolean(r.visited),
    });
  }
  return out;
}

async function loadCreations(): Promise<Map<string, Map<string, { boxes: number; projects: number; workstreams: number }>>> {
  const rows = await prisma.$queryRaw<Array<{ user_id: string; day: string; boxes: number; projects: number; workstreams: number }>>`
    WITH pr AS (
      SELECT p."userId" AS user_id, p."createdAt"::date::text AS day, count(*) AS projects, 0 AS boxes
      FROM projects p WHERE NOT p.archived GROUP BY 1, 2
    ), ws AS (
      SELECT p."userId" AS user_id, w."createdAt"::date::text AS day, 0 AS projects, count(*) AS workstreams
      FROM workstreams w JOIN projects p ON p.id = w."projectId"
      WHERE NOT p.archived AND NOT w.archived GROUP BY 1, 2
    ), bx AS (
      SELECT i."userId" AS user_id, i."createdAt"::date::text AS day, count(*) AS boxes
      FROM instances i WHERE i."userId" IS NOT NULL GROUP BY 1, 2
    )
    SELECT COALESCE(pr.user_id, ws.user_id, bx.user_id) AS user_id,
           COALESCE(pr.day, ws.day, bx.day) AS day,
           COALESCE(pr.projects, 0) + COALESCE(ws.projects, 0) AS projects,
           COALESCE(ws.workstreams, 0) AS workstreams,
           COALESCE(bx.boxes, 0) AS boxes
    FROM pr FULL JOIN ws ON ws.user_id = pr.user_id AND ws.day = pr.day
    FULL JOIN bx ON bx.user_id = COALESCE(pr.user_id, ws.user_id) AND bx.day = COALESCE(pr.day, ws.day)
  `;
  const out = new Map<string, Map<string, { boxes: number; projects: number; workstreams: number }>>();
  for (const r of rows) {
    let m = out.get(r.user_id);
    if (!m) out.set(r.user_id, m = new Map());
    m.set(r.day, { boxes: Number(r.boxes), projects: Number(r.projects), workstreams: Number(r.workstreams) });
  }
  return out;
}

/** Rebuild every user's segment rows from their createdAt through today. */
export async function rebuildSegments(): Promise<{ users: number; rows: number }> {
  status.state = 'running';
  status.lastRunAt = new Date().toISOString();
  try {
    const out = await rebuildGroups();
    status.state = 'idle'; status.lastError = null;
    status.lastRebuiltDay = isoToday();
    return out;
  } catch (err) {
    status.state = 'error';
    status.lastError = (err as Error).message.slice(0, 300);
    console.error('[SEGMENTS] rebuild failed:', status.lastError);
    throw err;
  }
}

async function rebuildGroups(): Promise<{ users: number; rows: number }> {
  const users = await prisma.user.findMany({
    select: { id: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const signals = await loadUserDays();
  const creations = await loadCreations();
  const today = isoToday();
  let rows = 0;
  for (const u of users) {
    const dues: Array<{ date: string; segment: Segment; agentMs: number; humanMs: number; tokenRows: number; visited: boolean }> = [];
    const days = signals.get(u.id) ?? new Map();
    const created = u.createdAt.toISOString().slice(0, 10);
    let d = created;
    const active = new Set<string>();
    for (const [day, s] of days) {
      if (day >= created && isActiveDay(s)) active.add(day);
    }
    for (; d <= today; d = nextDay(d)) {
      const s = days.get(d) ?? { agentMs: 0, humanMs: 0, tokenRows: 0, visited: false };
      const seg = segmentFor(created, active, creations.get(u.id) ?? new Map(), d);
      dues.push({ date: d, segment: seg, agentMs: s.agentMs, humanMs: s.humanMs, tokenRows: s.tokenRows, visited: s.visited });
    }
    for (const row of dues) {
      await prisma.userSegmentDaily.upsert({
        where: { userId_date: { userId: u.id, date: row.date } },
        create: { userId: u.id, date: row.date, segment: row.segment, agentMs: row.agentMs, humanMs: row.humanMs, tokenRows: row.tokenRows, visited: row.visited },
        update: { segment: row.segment, agentMs: row.agentMs, humanMs: row.humanMs, tokenRows: row.tokenRows, visited: row.visited },
      });
      rows++;
    }
  }
  return { users: users.length, rows };
}

function nextDay(iso: string): string {
  return new Date(Date.parse(iso + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
}

async function tick(): Promise<void> {
  // Rebuild when a row for today does not exist yet. Rows are upserted per run,
  // so each user's segment only changes when the sliding windows say so.
  const today = isoToday();
  const haveToday = await prisma.userSegmentDaily.findFirst({ where: { date: today }, select: { id: true } });
  if (haveToday) return;
  const r = await rebuildSegments();
  status.lastRebuiltDay = today;
  console.log(`[SEGMENTS] rebuilt ${r.rows} rows for ${r.users} users`);
}

async function runRebuild(): Promise<void> {
  try {
    await rebuildSegments();
  } catch { /* status already carries the error */ }
}

/** Start the tracker: check every 10 minutes, backfill on boot. */
export function startSegmentTracker(): void {
  if (timer) return;
  void runRebuild();
  timer = setInterval(() => {
    if (running) return;
    running = runRebuild().finally(() => { running = null; });
  }, 10 * 60 * 1000);
  timer.unref();
}

/** Rebuild now (ops button): computes all missing days and writes. */
export async function segmentTrackerTick(): Promise<{ status: TrackerStatus }> {
  await runRebuild();
  return { status: segmentTrackerStatus() };
}

export async function stopSegmentTracker(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null; }
  if (running) await running;
}
