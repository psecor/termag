// What a review session's reviewer returns: a
// ```review fence of JSON, which termag draws natively as the review card
// (pages/chat/ReviewCard.tsx), not as generative UI, because its Post is
// termag's own. Two shapes: the findings of a round, and a follow-up round
// that checks the user's posted comments against a new head. A fence is
// untrusted model output: only what has its shape is drawn, and text stays text.

export type ReviewTier = 'blocks-merge' | 'blocks-flag' | 'recommend' | 'question';
export type ReviewDecision = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
export const TIERS: readonly ReviewTier[] = ['blocks-merge', 'blocks-flag', 'recommend', 'question'];
export const DECISIONS: readonly ReviewDecision[] = ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'];

export interface ReviewFinding {
  id: string;
  tier: ReviewTier;
  title: string;
  why: string;
  ask: string | null;
  /** Where its inline comment goes (a line on the PR's head); none puts it in the summary. */
  at: { path: string; line: number } | null;
  /** The inline comment as it would post, in the user's voice. */
  comment: string | null;
  /** Ticked to begin with: the reviewer's suggestion. */
  ticked: boolean;
}

export interface ReviewFindings {
  kind: 'findings';
  round: number;
  /** The head the reviewer read, short or full. */
  head: string;
  verdict: ReviewDecision;
  take: string;
  summary: string;
  findings: ReviewFinding[];
  checked: string[];
}

export interface ReviewFollowUp {
  kind: 'followup';
  round: number;
  head: string;
  /** Each of the user's posted comments and what the new head does about it. */
  addressed: Array<{ title: string; how: string; fixed: boolean }>;
  /** Anything new in the changed lines. */
  fresh: string[];
}

export type ReviewFence = ReviewFindings | ReviewFollowUp;

const MAX = { findings: 30, text: 4000, comment: 8000, checked: 20 };
const str = (v: unknown, max = MAX.text): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** A ```review fence's JSON, checked: anything without the shape is dropped, never guessed. */
export function readReviewFence(text: string): ReviewFence | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const round = Number.isInteger(r.round) && (r.round as number) > 0 ? r.round as number : 1;
  const head = str(r.head, 64) ?? '';
  if (r.kind === 'followup') {
    const addressed = (Array.isArray(r.addressed) ? r.addressed : []).flatMap(a => {
      const x = a as Record<string, unknown>;
      const title = str(x?.title, 300);
      return title ? [{ title, how: str(x.how) ?? '', fixed: x.fixed !== false }] : [];
    }).slice(0, MAX.findings);
    const fresh = (Array.isArray(r.fresh) ? r.fresh : []).map(f => str(f)).filter((f): f is string => !!f).slice(0, MAX.findings);
    return { kind: 'followup', round, head, addressed, fresh };
  }
  if (r.kind !== 'findings' && r.kind !== undefined) return null;
  const verdict = DECISIONS.includes(r.verdict as ReviewDecision) ? r.verdict as ReviewDecision : 'COMMENT';
  const seen = new Set<string>();
  const findings = (Array.isArray(r.findings) ? r.findings : []).flatMap((f, i) => {
    const x = f as Record<string, unknown>;
    const title = str(x?.title, 300);
    const why = str(x?.why) ?? '';
    if (!title || !TIERS.includes(x.tier as ReviewTier)) return [];
    let id = str(x.id, 40) ?? `f${i + 1}`;
    if (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    const at = x.at as Record<string, unknown> | undefined;
    const path = str(at?.path, 500);
    const line = Number.isInteger(at?.line) && (at!.line as number) > 0 ? at!.line as number : null;
    return [{
      id, tier: x.tier as ReviewTier, title, why, ask: str(x.ask), at: path && line ? { path, line } : null,
      comment: str(x.comment, MAX.comment), ticked: x.ticked !== false,
    }];
  }).slice(0, MAX.findings);
  const checked = (Array.isArray(r.checked) ? r.checked : []).map(c => str(c, 300)).filter((c): c is string => !!c).slice(0, MAX.checked);
  return { kind: 'findings', round, head, verdict, take: str(r.take) ?? '', summary: str(r.summary) ?? '', findings, checked };
}

/** A finding's inline comment as it would post, or null when it belongs in the summary. */
export function inlineOf(f: ReviewFinding): { path: string; line: number; body: string } | null {
  if (!f.at) return null;
  return { ...f.at, body: f.comment ?? [`**${f.title}.**`, f.why, f.ask ? `Could you ${f.ask.replace(/^\w/, c => c.toLowerCase())}` : ''].filter(Boolean).join(' ') };
}

/** The review's summary as it would post: the reviewer's, then the ticked findings that have no line. */
export function summaryOf(r: ReviewFindings, ticked: (f: ReviewFinding) => boolean, credit: string | null): string {
  const loose = r.findings.filter(f => ticked(f) && !f.at).map(f => `- **${f.title}.** ${f.why}${f.ask ? ` ${f.ask}` : ''}`);
  return [r.summary, loose.length ? loose.join('\n') : '', credit ?? ''].filter(Boolean).join('\n\n');
}

/**
 * What a review session's first prompt asks for, after the lab's own prompt:
 * the findings as a ```review fence. It says the reviewer doesn't post: the
 * user does, from the card. Sent after a marker the chat draws as a chip.
 */
export const REVIEW_FORMAT_MARK = '\n\n[termag: the review card]\n';
export function reviewFormatInstruction(prKey: string): string {
  return `${REVIEW_FORMAT_MARK}After the description and the key points, give the findings I could post as one fenced block tagged review, holding this JSON (no comments in it):
{"kind":"findings","pr":"${prKey}","round":1,"head":"<the head commit you read>","verdict":"COMMENT | REQUEST_CHANGES | APPROVE","take":"one or two sentences: your take and why","summary":"the review's summary as it would post","findings":[{"id":"f1","tier":"blocks-merge | blocks-flag | recommend | question","title":"…","why":"the concrete consequence","ask":"what to ask the author for","at":{"path":"…","line":<the line on the PR's head>},"comment":"the inline comment, in my voice","ticked":true}],"checked":["what you checked and found clean"]}
Block the merge only on harm you can show. Don't post anything to GitHub: I post from the card.`;
}

/**
 * What termag sends a review session when the author answers (Check the
 * fixes): an event line the chat draws as one, then, folded, what it asks.
 */
export const TERMAG_NOTE = '[termag] ';
export function followUpMessage(o: { author: string | null; prKey: string; head: string | null; round: number; askedAgain: boolean }): string {
  const who = o.author ?? 'The author';
  const what = o.askedAgain ? `asked for your review of ${o.prKey} again` : `pushed to ${o.prKey} since your review`;
  return `${TERMAG_NOTE}${who} ${what}${o.head ? ` (now ${o.head.slice(0, 7)})` : ''}.${REVIEW_FORMAT_MARK}Fetch the PR's new head and check each of the comments I posted in round ${o.round} against it, then anything new in the changed lines. Answer with one fenced block tagged review holding this JSON: {"kind":"followup","pr":"${o.prKey}","round":${o.round + 1},"head":"<the head you read>","addressed":[{"title":"<my comment, short>","how":"what the head does about it","fixed":true}],"fresh":["anything new worth a comment"]}. Don't post anything to GitHub.`;
}
