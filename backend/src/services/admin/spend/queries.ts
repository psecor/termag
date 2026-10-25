/**
 * Loads what the spend model (./model.ts) needs and persists its config.
 * The REST routes (routes/admin/spend.ts) and the MCP
 * tools both call these, so the two surfaces cannot drift.
 */
import { prisma } from '../../../db';
import type { Range } from '../range';
import { dayKey } from '../range';
import { tokenSourceSql } from '../tokenSource';
import { computeSpend, spendTrend, type Pool, type PoolAllocation, type PoolKind, type PoolShare, type Price, type SpendConfig, type SpendReport, type SpendWeek, type TokenDay } from './model';
import { DEFAULT_CONFIG, DEFAULT_POOLS, DEFAULT_PRICES } from './config';

const SETTINGS_ID = 'settings';

/** The settings row, creating it and the default prices and pools the first time. */
async function ensureSeeded() {
  // The tab's first load sends several requests at once; an upsert racing another's insert loses with P2002.
  const s = await prisma.spendSettings.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID }, update: {} })
    .catch(async (err: { code?: string }) => {
      if (err?.code !== 'P2002') throw err;
      return prisma.spendSettings.findUniqueOrThrow({ where: { id: SETTINGS_ID } });
    });
  if (s.seeded) return s;
  return prisma.$transaction(async tx => {
    // Claim the seed first, so two first readers cannot both insert the defaults.
    const claimed = await tx.spendSettings.updateMany({ where: { id: SETTINGS_ID, seeded: false }, data: { seeded: true, modelMix: DEFAULT_CONFIG.modelMix } });
    if (claimed.count === 1) {
      await tx.modelPrice.createMany({ data: DEFAULT_PRICES, skipDuplicates: true });
      await tx.spendPool.createMany({ data: DEFAULT_POOLS });
    }
    return tx.spendSettings.findUniqueOrThrow({ where: { id: SETTINGS_ID } });
  });
}

function toMix(v: unknown): SpendConfig['modelMix'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: SpendConfig['modelMix'] = {};
  for (const [prov, models] of Object.entries(v as Record<string, unknown>)) {
    if (!models || typeof models !== 'object') continue;
    out[prov] = Object.fromEntries(Object.entries(models as Record<string, unknown>).filter(([, w]) => typeof w === 'number')) as Record<string, number>;
  }
  return out;
}

type PoolRow = Awaited<ReturnType<typeof prisma.spendPool.findMany>>[number];
const toPool = (r: PoolRow): Pool => ({
  id: r.id, name: r.name, kind: r.kind as PoolKind, providers: r.providers,
  annualUsd: r.annualUsd, boxes: r.boxes, boxCostUsd: r.boxCostUsd, usersPerBox: r.usersPerBox,
  share: r.share as PoolShare, shareValue: r.shareValue, populationLabel: r.populationLabel, populationSize: r.populationSize,
  allocation: r.allocation as PoolAllocation, startDate: r.startDate, endDate: r.endDate, note: r.note, sort: r.sort,
});

export interface SpendModelConfig { config: SpendConfig; prices: Price[]; pools: Pool[]; updatedAt: string }

export async function getSpendConfig(): Promise<SpendModelConfig> {
  const s = await ensureSeeded();
  const [prices, pools] = await Promise.all([
    prisma.modelPrice.findMany({ orderBy: [{ provider: 'asc' }, { model: 'asc' }, { effectiveFrom: 'asc' }] }),
    prisma.spendPool.findMany({ orderBy: [{ sort: 'asc' }, { name: 'asc' }] }),
  ]);
  return {
    config: { loadedCostUsd: s.loadedCostUsd, orgHeadcount: s.orgHeadcount, modelMix: toMix(s.modelMix) },
    prices: prices.map(p => ({ provider: p.provider, model: p.model, effectiveFrom: p.effectiveFrom, input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite })),
    pools: pools.map(toPool),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** Replace the whole model (already validated by config.ts). Pools keep their ids when the edit carries them. */
export async function saveSpendConfig(next: { config: SpendConfig; prices: Price[]; pools: Array<Omit<Pool, 'id'> & { id?: string }> }): Promise<SpendModelConfig> {
  await ensureSeeded();
  await prisma.$transaction(async tx => {
    await tx.spendSettings.update({ where: { id: SETTINGS_ID }, data: { loadedCostUsd: next.config.loadedCostUsd, orgHeadcount: next.config.orgHeadcount, modelMix: next.config.modelMix } });
    await tx.modelPrice.deleteMany({});
    if (next.prices.length) await tx.modelPrice.createMany({ data: next.prices });
    const keep = next.pools.map(p => p.id).filter((id): id is string => !!id);
    await tx.spendPool.deleteMany({ where: { id: { notIn: keep } } });
    for (const { id, ...data } of next.pools) {
      if (id && await tx.spendPool.findUnique({ where: { id }, select: { id: true } })) await tx.spendPool.update({ where: { id }, data });
      else await tx.spendPool.create({ data });
    }
  });
  return getSpendConfig();
}

async function tokenDays(sinceKey: string, untilKey: string): Promise<TokenDay[]> {
  const rows = await prisma.$queryRaw<Array<{ userId: string; provider: string; date: string; estimated: boolean; input: number; output: number; cacheRead: number; cacheCreate: number; reasoning: number }>>`
    SELECT t."userId", t."provider", t."date", t."estimated",
           SUM(t."input")::float8 AS "input", SUM(t."output")::float8 AS "output",
           SUM(t."cacheRead")::float8 AS "cacheRead", SUM(t."cacheCreate")::float8 AS "cacheCreate",
           SUM(t."reasoning")::float8 AS "reasoning"
    FROM ${tokenSourceSql(sinceKey, untilKey)} t
    GROUP BY t."userId", t."provider", t."date", t."estimated"`;
  return rows.map(r => ({
    userId: r.userId, provider: r.provider, date: r.date, estimated: r.estimated,
    input: Number(r.input), output: Number(r.output), cacheRead: Number(r.cacheRead), cacheCreate: Number(r.cacheCreate), reasoning: Number(r.reasoning),
  }));
}

/** Every user signed up by the end of the window: the "all termag users" denominator. */
async function usersBy(untilTs: Date) {
  const rows = await prisma.user.findMany({ where: { createdAt: { lt: untilTs } }, select: { id: true, unixUsername: true } });
  return rows.map(u => ({ id: u.id, name: u.unixUsername }));
}

/**
 * userId → provider → agent ms in the window. work_time_entries keys people by
 * unix username and days server-local; agent-written rows carry the tmux-safe
 * form (`.` and `:` folded to `_`, services/tmux.ts tmuxSafeName), so match either.
 */
async function agentMs(range: Range): Promise<Map<string, Map<string, number>>> {
  const rows = await prisma.$queryRaw<Array<{ userId: string; provider: string; ms: number }>>`
    SELECT u.id AS "userId", w."provider", SUM(w."totalMs")::float8 AS ms
    FROM work_time_entries w JOIN users u ON w."username" IN (u."unixUsername", translate(u."unixUsername", '.:', '__'))
    WHERE w."provider" <> 'human' AND w."date" >= ${range.worktimeSinceKey} AND w."date" <= ${range.worktimeUntilKey}
    GROUP BY u.id, w."provider"`;
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = out.get(r.userId) ?? new Map<string, number>(); out.set(r.userId, m);
    m.set(r.provider, Number(r.ms));
  }
  return out;
}

/**
 * Peak people at once on a pool's providers: per minute of context_samples,
 * the distinct owners of workstreams that had tokens on those providers that
 * day. An undercount where a provider reports no context;
 * null when nothing was seen.
 */
async function peakConcurrent(range: Range, providers: string[]): Promise<number | null> {
  if (!providers.length) return null;
  const rows = await prisma.$queryRaw<Array<{ peak: number | null }>>`
    WITH ws AS (
      SELECT DISTINCT "projectId", "workstream", "date" FROM token_usage_days
      WHERE "provider" = ANY(${providers}) AND NOT "estimated" AND "projectId" IS NOT NULL AND "workstream" IS NOT NULL
        AND "date" >= ${range.sinceKey} AND "date" <= ${range.untilKey}
    ), m AS (
      SELECT c."bucket", COUNT(DISTINCT p."userId") AS n
      FROM context_samples c
      JOIN ws ON ws."projectId" = c."projectId" AND ws."workstream" = c."workstream" AND ws."date" = to_char(c."bucket" AT TIME ZONE 'UTC', 'YYYY-MM-DD')
      JOIN projects p ON p.id = c."projectId"
      WHERE c."bucket" >= ${range.sinceTs} AND c."bucket" < ${range.untilTs}
      GROUP BY c."bucket"
    )
    SELECT MAX(n)::int AS peak FROM m`;
  const v = rows[0]?.peak;
  return v == null ? null : Number(v);
}

export async function spendReport(range: Range, activeOnly: boolean): Promise<SpendReport & { updatedAt: string }> {
  const model = await getSpendConfig();
  const infra = model.pools.filter(p => p.kind === 'infra');
  const [tokens, users, ms, peaks] = await Promise.all([
    tokenDays(range.sinceKey, range.untilKey), usersBy(range.untilTs), agentMs(range),
    Promise.all(infra.map(async p => [p.id, await peakConcurrent(range, p.providers)] as const)),
  ]);
  const peakMap = new Map<string, number>();
  for (const [id, v] of peaks) if (v != null) peakMap.set(id, v);
  const report = computeSpend({
    days: range.keys, tokens, prices: model.prices, pools: model.pools, config: model.config,
    users, activeOnly, agentMs: ms, peakConcurrent: peakMap,
  });
  return { ...report, updatedAt: model.updatedAt };
}

export const TREND_MAX_WEEKS = 52;

/** The last `weeks` Monday-UTC weeks, the current one partial. */
export async function spendTrendReport(weeks: number, now: Date = new Date()): Promise<{ weeks: SpendWeek[] }> {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * 86_400_000);
  const start = new Date(monday.getTime() - (weeks - 1) * 7 * 86_400_000);
  const days: string[] = [];
  for (let d = start; d.getTime() <= today.getTime(); d = new Date(d.getTime() + 86_400_000)) days.push(dayKey(d));
  const model = await getSpendConfig();
  const [tokens, users] = await Promise.all([tokenDays(days[0], days[days.length - 1]), usersBy(new Date(today.getTime() + 86_400_000))]);
  return { weeks: spendTrend({ days, tokens, prices: model.prices, pools: model.pools, config: model.config, users }) };
}
