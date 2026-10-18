/**
 * The composing model's answer: find the JSON object in its text, validate
 * it against BriefingContent, and clamp every string, so what is stored and
 * shown (card, Slack DM) is bounded whatever the model wrote.
 */
import { z } from 'zod';
import type { BriefingContent } from './types';

const clamp = (max: number) => z.string().transform(s => s.replace(/\s+/g, ' ').trim().slice(0, max));
const id = z.union([z.string().max(64), z.null()]).optional().transform(v => (v ? v : null));

const schema = z.object({
  summary: clamp(1200),
  carryovers: z.array(z.object({
    projectId: id,
    workstream: id,
    kind: z.enum(['question', 'decision', 'action', 'blocked']).catch('action'),
    title: clamp(200),
    detail: clamp(600).optional().default(''),
    evidence: z.enum(['transcript', 'todo', 'status', 'pr', 'git', 'cloud', 'pane']).catch('status'),
  })).max(40).optional().default([]),
  suggestions: z.array(z.object({
    projectId: id,
    workstream: id,
    text: clamp(300),
    why: clamp(400).optional().default(''),
  })).max(12).optional().default([]),
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

export function parseBriefingContent(text: string): { ok: true; content: BriefingContent } | { ok: false; error: string } {
  const raw = extractJson(text);
  if (raw === null) return { ok: false, error: 'The review did not return JSON' };
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, error: `The review's JSON did not match the briefing shape: ${r.error.issues[0]?.message ?? 'invalid'}` };
  const content = r.data as BriefingContent;
  if (!content.summary) return { ok: false, error: 'The review returned an empty summary' };
  return { ok: true, content };
}

/** Drop project ids the user cannot see, so a link never points at someone else's project. */
export function scrubProjectIds(content: BriefingContent, visible: ReadonlySet<string>): BriefingContent {
  const fix = <T extends { projectId: string | null; workstream: string | null }>(x: T): T =>
    x.projectId && !visible.has(x.projectId) ? { ...x, projectId: null, workstream: null } : x;
  return { ...content, carryovers: content.carryovers.map(fix), suggestions: content.suggestions.map(fix) };
}
