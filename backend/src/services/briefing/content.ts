/**
 * The composing model's answer: find the JSON object in its text, validate
 * it against BriefingContent (version 2: headline, Worked on, Left open, Work
 * better), and clamp every string, so what is stored and shown (card, Slack
 * DM) is bounded whatever the model wrote. Short bullets, not paragraphs:
 * the clamps are the format.
 *
 * Rows written before version 2 (summary, carryovers, suggestions) are read
 * through upgradeContent, so every surface renders one shape.
 */
import { z } from 'zod';
import type { BriefingContent, BriefingContentV1, LedgerPattern } from './types';
import { openKey, patternKey } from './dismissals';

const clamp = (max: number) => z.string().transform(s => s.replace(/\s+/g, ' ').trim().slice(0, max));
const id = z.union([z.string().max(64), z.null()]).optional().transform(v => (v ? v : null));
const PR_REF = /^[\w.-]+\/[\w.-]+#\d{1,9}$/;
const prRef = z.union([z.string(), z.null()]).optional().transform(v => (v && PR_REF.test(v.trim()) ? v.trim() : null));
const KINDS = ['question', 'decision', 'action', 'blocked'] as const;
const EVIDENCE = ['transcript', 'todo', 'status', 'pr', 'git', 'cloud', 'pane'] as const;

const schema = z.object({
  headline: clamp(200),
  workedOn: z.array(z.object({
    projectId: id,
    workstream: id,
    text: clamp(160),
    prs: z.array(z.unknown()).optional().default([])
      .transform(xs => xs.filter((x): x is string => typeof x === 'string' && PR_REF.test(x.trim())).map(x => x.trim()).slice(0, 4)),
  })).max(30).optional().default([]),
  leftOpen: z.array(z.object({
    projectId: id,
    workstream: id,
    kind: z.enum(KINDS).catch('action'),
    title: clamp(120),
    detail: clamp(240).optional().default(''),
    evidence: z.enum(EVIDENCE).catch('status'),
    pr: prRef,
  })).max(20).optional().default([]),
  workBetter: z.array(z.object({
    patternId: z.string().max(240),
    text: clamp(160),
    why: clamp(200).optional().default(''),
  })).max(5).optional().default([]),
});

/** The first top-level JSON object in a model's text: a fenced block, or the outermost braces. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try { return JSON.parse(c.slice(start, end + 1)); } catch { /* try the next */ }
  }
  return null;
}

/**
 * Parse the model's text. `patterns` is the ledger's list when the backend
 * still has it: a Work better item must name one of them (else it is dropped,
 * since an invented pattern has nothing for Done to name), and takes its
 * project from it. Without the list, any well-formed id is kept.
 */
export function parseBriefingContent(text: string, patterns: LedgerPattern[] | null = null): { ok: true; content: BriefingContent } | { ok: false; error: string } {
  const found = extractJson(text);
  if (found === null) return { ok: false, error: 'The review did not return JSON' };
  const r = schema.safeParse(v1AsV2Answer(found));
  if (!r.success) return { ok: false, error: `The review's JSON did not match the briefing shape: ${r.error.issues[0]?.message ?? 'invalid'}` };
  const d = r.data;
  if (!d.headline) return { ok: false, error: 'The review returned an empty headline' };
  const known = patterns ? new Map(patterns.map(p => [p.id, p])) : null;
  const seen = new Set<string>();
  const workBetter: BriefingContent['workBetter'] = [];
  for (const w of d.workBetter) {
    const pid = w.patternId.trim();
    // Any non-space id: big-context ids carry the workstream, often a branch name (feat/x).
    if (!/^\S{1,240}$/.test(pid) || seen.has(pid) || !w.text) continue;
    const p = known ? known.get(pid) : undefined;
    if (known && !p) continue;
    seen.add(pid);
    workBetter.push({ key: patternKey(pid), projectId: p?.projectId ?? null, workstream: p?.workstream ?? null, text: w.text, why: w.why });
  }
  return {
    ok: true,
    content: {
      version: 2,
      headline: d.headline,
      workedOn: d.workedOn.filter(w => w.text),
      leftOpen: d.leftOpen.filter(x => x.title).map(x => ({ ...x, key: openKey(x.projectId, x.workstream, x.pr) })),
      workBetter,
    },
  };
}

/**
 * A run that fetched its prompt before a deploy answers in the first shape
 * (summary, carryovers, suggestions); read it as a version 2 answer rather
 * than fail the briefing, which for a scheduled run would lose that day.
 */
function v1AsV2Answer(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  if ('headline' in r || typeof r.summary !== 'string') return raw;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
  return {
    headline: r.summary,
    workedOn: [],
    leftOpen: [
      ...list(r.carryovers).map(x => ({ ...x, pr: null })),
      ...list(r.suggestions).map(x => ({ projectId: x.projectId, workstream: x.workstream, kind: 'action', title: x.text, detail: x.why, evidence: 'status', pr: null })),
    ],
    workBetter: [],
  };
}

/** Any stored content as version 2: version 1 rows map summary → headline, carryovers and suggestions → Left open. */
export function upgradeContent(raw: unknown): BriefingContent | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<BriefingContent> & Partial<BriefingContentV1>;
  if (c.version === 2) return c as BriefingContent;
  return {
    version: 2,
    headline: c.summary ?? '',
    workedOn: [],
    leftOpen: [
      ...(c.carryovers ?? []).map(x => ({ ...x, pr: null, key: openKey(x.projectId, x.workstream, null) })),
      ...(c.suggestions ?? []).map(x => ({
        key: openKey(x.projectId, x.workstream, null), projectId: x.projectId, workstream: x.workstream,
        kind: 'action' as const, title: x.text, detail: x.why, evidence: 'status' as const, pr: null,
      })),
    ],
    workBetter: [],
  };
}

/** "owner/name#123" → its GitHub URL. */
export function prUrl(ref: string): string | null {
  const m = /^([\w.-]+\/[\w.-]+)#(\d{1,9})$/.exec(ref);
  return m ? `https://github.com/${m[1]}/pull/${m[2]}` : null;
}

/** Every project a content names. */
export function contentProjectIds(c: BriefingContent | null): string[] {
  if (!c) return [];
  return [...c.workedOn, ...c.leftOpen, ...c.workBetter].map(x => x.projectId).filter((x): x is string => !!x);
}

/** Drop project ids the user cannot see, so a link never points at someone else's project. */
export function scrubProjectIds(content: BriefingContent, visible: ReadonlySet<string>): BriefingContent {
  const fix = <T extends { projectId: string | null; workstream: string | null }>(x: T): T =>
    x.projectId && !visible.has(x.projectId) ? { ...x, projectId: null, workstream: null } : x;
  return {
    ...content,
    workedOn: content.workedOn.map(fix),
    leftOpen: content.leftOpen.map(x => {
      const y = fix(x);
      return y === x ? x : { ...y, key: openKey(null, null, y.pr) };
    }),
    workBetter: content.workBetter.map(fix),
  };
}
