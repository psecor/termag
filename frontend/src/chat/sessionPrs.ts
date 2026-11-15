import type { PrRow } from '../services/api';
import type { AskView } from './asks';
import { parsePrRef } from './reviews';

export interface SessionPrRef {
  key: string;
  repo: string;
  number: number;
  ask: Pick<AskView, 'thread' | 'title'> | null;
}

/** The session's own PR first, then every PR its asks published, once per repository and number. */
export function sessionPrRefs(own: PrRow | null, asks: Iterable<Pick<AskView, 'thread' | 'title' | 'prs'>>): SessionPrRef[] {
  const refs = new Map<string, SessionPrRef>();
  const add = (repo: string, number: number, ask: SessionPrRef['ask']) => {
    const key = `${repo.toLowerCase()}#${number}`;
    if (!refs.has(key)) refs.set(key, { key, repo, number, ask });
  };
  if (own?.repo && own.number != null) add(own.repo, own.number, null);
  for (const ask of asks) {
    for (const pr of ask.prs) {
      const ref = parsePrRef(pr.url);
      if (ref && ref.number > 0) add(ref.repo, ref.number, { thread: ask.thread, title: ask.title });
    }
  }
  return [...refs.values()];
}
