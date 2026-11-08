// A day's meta.json, read as data. It is agent-written
// like the rest of a day, so it is never a module: the registry reads it as
// text, and only an object that passes these checks is used, copied field by
// field. lint.ts runs the same checks in CI.

import type { DailyThemeMeta } from './types';

const KEYS = ['date', 'title', 'blurb', 'sources'];
const SOURCE_KEYS = ['label', 'url'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What is wrong with a day's parsed meta.json, one line each; empty when it is fine. */
export function metaErrors(meta: unknown, date: string): string[] {
  const where = `${date}/meta.json`;
  if (!isRecord(meta)) return [`${where}: is a JSON object`];
  const errors: string[] = [];
  const extra = Object.keys(meta).filter(k => !KEYS.includes(k));
  if (extra.length) errors.push(`${where}: unknown keys ${extra.join(', ')}`);
  if (meta.date !== date) errors.push(`${where}: date is "${String(meta.date)}", not the directory's`);
  const text = (key: 'title' | 'blurb', max: number) => {
    const v = meta[key];
    if (typeof v !== 'string' || !v.trim()) errors.push(`${where}: ${key} is required`);
    else if (v.length > max) errors.push(`${where}: ${key} is over ${max} characters`);
    else if (/[<>]/.test(v)) errors.push(`${where}: ${key} is plain text (no < or >)`);
  };
  text('title', 60);
  text('blurb', 280);
  const sources = meta.sources;
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 6) {
    errors.push(`${where}: sources lists 1 to 6 links`);
  } else {
    sources.forEach((s, i) => {
      if (!isRecord(s)) { errors.push(`${where}: sources[${i}] is an object`); return; }
      const extraS = Object.keys(s).filter(k => !SOURCE_KEYS.includes(k));
      if (extraS.length) errors.push(`${where}: sources[${i}] has unknown keys ${extraS.join(', ')}`);
      if (typeof s.label !== 'string' || !s.label.trim() || s.label.length > 100) errors.push(`${where}: sources[${i}].label is 1 to 100 characters`);
      let ok = false;
      try { ok = new URL(String(s.url)).protocol === 'https:'; } catch { /* not a URL */ }
      if (!ok) errors.push(`${where}: sources[${i}].url is an https URL`);
    });
  }
  return errors;
}

/** A day's meta.json text as a DailyThemeMeta, or null when it doesn't parse or pass metaErrors. */
export function parseDailyThemeMeta(text: string, date: string): DailyThemeMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (metaErrors(parsed, date).length) return null;
  const m = parsed as DailyThemeMeta;
  return {
    date: m.date,
    title: m.title,
    blurb: m.blurb,
    sources: m.sources.map(s => ({ label: s.label, url: s.url })),
  };
}
