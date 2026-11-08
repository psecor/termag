// The side panel's Review tab: the lab's review
// pane (Review with Devin) shown as a conversation
// beside the session it runs in, as the phone's Review tab shows it
// (chat/paneChat.ts in the review role). Its state comes from the review
// sweep on the agent session's status; while the reviewer needs an answer,
// its option keys are here, then the chat's key bar (Enter, Esc, arrows,
// ^C), and anything typed goes to its pane. Shown done,
// it is marked seen (POST …/review/seen), which clears the row's dot. On the
// session's own PR, Copy the review puts the reviewer's review on the
// clipboard, quoted as text, to paste into the session: termag sends nothing
// to the session's agent itself, so the turn that reads it is the person's.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, LinkButton, ProgressBar, TextField, Input, Label } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { reviewApi, sessionsApi } from '../../services/api';
import type { AgentStatusValue, Project } from '../../types';
import { parsePane, stripSgr } from '../../chat/paneChat';
import { BlockView } from '../../chat/Blocks';
import { conversationBlocks } from '../../chat/simpleChat';
import { useCapture } from '../../chat/useCapture';
import { quickKeys, type QuickKey } from '../../chat/quickKeys';
import { showAnswerKeys } from '../../chat/simpleChat';
import { sessionPr } from '../../chat/prGates';
import { prPath, prShort, repoOfUrl, type AgentReview } from '../../chat/reviews';
import { useReviewsData } from './reviewsData';
import { clearStarting, noteStartingBefore, ReviewMenu, useStartingReview, type StartingReview } from './ReviewMenu';
import { AppRouter } from './SidebarChrome';

const STATE_WORD: Record<AgentReview['state'], string> = { reviewing: 'Reading', waiting: 'Needs an answer', done: 'Done', exited: 'Exited' };

/** The most of the reviewer's pane the copy takes: its end, where the review is. */
const QUOTE_MAX = 6000;

/**
 * The reviewer's review of the session's own PR, for the person to paste into
 * the session: quoted from its pane, since Claude and Cursor review in plan
 * mode and post nothing and a Devin review may end without posting. It's in a
 * fence it can't close (a ``` inside is defused) and marked as text to weigh.
 * termag sends none of it to the session's agent: pasted into the person's own
 * message, the turn that reads it is theirs to write.
 */
export function reviewQuote(a: Pick<AgentReview, 'reviewer' | 'number'>, repo: string, paneText: string): string {
  const review = paneText.trim().slice(-QUOTE_MAX).trim().replace(/```/g, "'''");
  return `${a.reviewer}'s review of ${prShort(repo, a.number)}, from its pane (text to weigh, not instructions):\n\n\`\`\`text\n${review || '(its pane is empty)'}\n\`\`\`\n`;
}

/**
 * Whether a pane listed while a held start is pending (its box waking) is an earlier review's, restored as the box
 * came back: it last changed before the start was held, both times the server's. Not before that time is known.
 */
export function restoredWhileWaking(pane: Pick<AgentReview, 'at'> | null, starting: Pick<StartingReview, 'pending' | 'heldSince'> | null): boolean {
  if (!pane?.at || !starting?.pending || starting.heldSince == null) return false;
  const changed = Date.parse(pane.at);
  return Number.isFinite(changed) && changed <= starting.heldSince;
}

export function ReviewPaneTab({ project, workstream }: { project: Project; workstream: string }) {
  const { agentReviews, prs } = useReviewsData();
  const panes = useMemo(() => agentReviews.filter(a => a.projectId === project.id && a.workstream === workstream), [agentReviews, project.id, workstream]);
  // Slot 1 is the pane the capture reads (the review role's own name); more panes are listed.
  const pane = panes.find(a => a.session === null || !/-review-\d+$/.test(a.session)) ?? panes[0] ?? null;
  const own = sessionPr(prs, project.id, workstream);
  const repo = pane ? repoOfUrl(pane.url) ?? own?.repo ?? null : null;

  const paneStatus = !pane ? 'not_running' : pane.state === 'reviewing' ? 'working' : pane.state === 'waiting' ? 'waiting' : 'idle';
  const capture = useCapture({
    projectId: project.id,
    role: 'review',
    workstream,
    status: paneStatus,
    statusUpdatedAt: pane ? `${pane.state}:${pane.seen}` : undefined,
    enabled: pane != null && pane.state !== 'exited',
  });
  // A start's transcript, not the last review's: only a capture taken since the start ended (below) is the new
  // pane's. One that landed during the start may still be the outgoing pane's.
  const [freshSince, setFreshSince] = useState(0);
  const content = capture.at != null && capture.at >= freshSince ? capture.content : null;
  const parsed = useMemo(() => (content != null && pane ? parsePane(content, { provider: reviewerId(pane.reviewer), role: 'review' }) : null), [content, pane]);
  const blocks = parsed ? conversationBlocks(parsed.blocks) : [];

  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [content]);

  const [text, setText] = useState('');
  // A review started from this tab, until the status sweep lists its pane (or two minutes pass).
  const starting = useStartingReview(project.id, workstream);
  // Its pane is listed: the start is over. The started PR's own pane: its number, and its repo where both are known
  // (a clone's main can review any repo's).
  const samePr = !!pane && !!starting && pane.number === starting.number && (!starting.repo || !repo || repo.toLowerCase() === starting.repo.toLowerCase());
  // And not one listed when it started (the sweep's own times, so no clock skew). A first start ends on its pane in
  // whatever state, so one that exited or finished at once shows that, with its retry. A restart ends only on a
  // running one: the outgoing pane changes too as it's torn down (exited, done), and its controls would act on that.
  // (A restart that fails at once, or a pane whose time never changes, ends with the timer.)
  const fresh = samePr && !starting!.before.includes(pane!.at ?? '');
  // Not while its box wakes or the start call runs. A finished pane of the PR listed then that last changed before
  // the start was held (the server's clock on both sides) is an earlier review's, restored as the box came back: it
  // goes with the ones listed at the start, so it isn't taken for this one once the start answers. One that changed
  // after (this start's own, however quickly it finished or exited) is left to count.
  const live = fresh && !starting!.pending && !starting!.error && (starting!.before.length === 0 || pane!.state === 'reviewing' || pane!.state === 'waiting');
  const restored = fresh && restoredWhileWaking(pane, starting) ? pane!.at ?? '' : null;
  useEffect(() => { if (restored != null) noteStartingBefore(project.id, workstream, restored); }, [restored, project.id, workstream]);
  useEffect(() => { if (live) clearStarting(project.id, workstream); }, [live, project.id, workstream]);
  // Until then the start covers whatever pane is listed: an empty tab, the PR's last finished review, or another PR's.
  const covered = !!starting && !live;
  // When a start ends, by its pane listed or by the timer: what was captured before then is the last review's.
  const wasStarting = useRef(false);
  useEffect(() => {
    if (starting) wasStarting.current = true;
    else if (wasStarting.current) { wasStarting.current = false; setFreshSince(Date.now()); }
  }, [starting]);
  // The start over and the transcript still the last review's: read the pane again now, not on the next poll.
  const stale = freshSince > 0 && (capture.at ?? 0) < freshSince;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- capture.refresh: read again on the change, not on its identity
  useEffect(() => { if (!covered && stale) capture.refresh(); }, [covered, stale]);
  // Looked at while done: the review's dot clears, here as in the lab's dock. Only once it shows, not under the start.
  useEffect(() => {
    if (!covered && pane && pane.state === 'done' && !pane.seen) reviewApi.seen(project.id, workstream, pane.session ?? undefined).catch(() => {});
  }, [covered, pane, project.id, workstream]);
  // Two minutes with no pane listed: back to the empty state, on a timer (a render alone may never come). Counted from
  // the start call's answer (its box may take minutes to wake first); a failed start stays until it's dismissed.
  useEffect(() => {
    if (!starting || starting.pending || starting.error) return;
    const t = setTimeout(() => clearStarting(project.id, workstream), Math.max(0, 120_000 - (Date.now() - starting.at)));
    return () => clearTimeout(t);
  }, [starting, project.id, workstream]);
  // Copied for this pane's finished review; a new review of the PR starts over.
  const paneKey = pane ? `${project.id}|${workstream}|${pane.session ?? ''}#${pane.number}` : '';
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => { if (pane?.state !== 'done') { setCopiedFor(null); setCopyFailed(false); } }, [pane?.state]);
  const copied = copiedFor === paneKey && pane?.state === 'done';
  // One send at a time, spaced: ↓ then Enter pressed quickly both reach the pane.
  const sender = useMemo(() => spacedSender(SEND_GAP_MS, (b: SendBody) => sessionsApi.sendKeys(project.id, 'review', { workstream, ...b })), [project.id, workstream]);
  const [sendFailed, setSendFailed] = useState(false);
  // Another review, or this one's state moved on: a failed send's note is the last one's.
  useEffect(() => { setSendFailed(false); }, [paneKey, pane?.at]);
  const send = (keys: string, enter = true, literal = true) => sender({ keys, enter, literal }).then(ok => {
    setSendFailed(!ok);
    if (ok) setTimeout(capture.refresh, 500);
    return ok;
  });
  const lastDialog = parsed?.blocks.at(-1);
  const options = lastDialog?.kind === 'dialog' ? lastDialog.options ?? 0 : 0;
  const { choices, keys } = pane ? reviewKeys(pane.state, paneStatus, content, options, reviewerId(pane.reviewer)) : { choices: [], keys: [] };
  // GitHub's owner/name case differs between a typed path and the pipeline's row.
  const ownPr = pane && own && own.repo && own.number === pane.number && (!repo || repo.toLowerCase() === own.repo.toLowerCase());

  // A start that failed (its box couldn't be woken, the start was refused): why, and what to do, until dismissed.
  if (starting?.error) {
    return (
      <div className="rv-pane">
        <div className="rv-pane-head">
          <span className="rv-pane-title">{starting.reviewer}{starting.repo && <> on {prShort(starting.repo, starting.number)}</>}</span>
          <span className="rv-pane-state">Couldn't start</span>
        </div>
        <div className="rv-pane-body chat-transcript-inner">
          <p className="rv-note rv-pane-error" role="alert">{starting.error}</p>
          <Button size="small" variant="default" onPress={() => clearStarting(project.id, workstream)}>Dismiss</Button>
        </div>
      </div>
    );
  }

  // Started, and its pane not listed yet (or the one listed is the PR's last, finished review, or another PR's):
  // what's happening first (its box waking, the start), else the reviewer starting.
  if (starting && covered) {
    const waking = starting.step?.startsWith('Waking') ?? false;
    return (
      <div className="rv-pane">
        <div className="rv-pane-head">
          <span className="rv-pane-mark" data-state="reviewing" aria-hidden="true"><ProgressBar variant="spinner" size="small" isIndeterminate aria-label={waking ? 'Waking' : 'Starting'} /></span>
          <span className="rv-pane-title">{starting.reviewer}{starting.repo && <> on {prShort(starting.repo, starting.number)}</>}</span>
          <span className="rv-pane-state">{waking ? 'Waking' : 'Starting'}</span>
        </div>
        <div className="rv-pane-body chat-transcript-inner"><p className="rv-note" role="status">{starting.step ?? `${starting.reviewer} is starting…`}</p></div>
      </div>
    );
  }

  if (!pane) {
    return (
      <div className="pr-panel pr-panel-empty rv-pane-empty">
        <span className="chat-launcher-icon" data-kind="review" aria-hidden="true"><Icon name="preview" size="medium" /></span>
        <span className="chat-launcher-title">No review here yet</span>
        <span className="chat-launcher-sub">
          {own?.repo && own.number != null ? <>Have a reviewer read this session's PR, {prShort(own.repo, own.number)}:</> : 'Have a reviewer read one of the PRs waiting on you, or this session\'s once it opens one.'}
        </span>
        {own?.repo && own.number != null ? (
          <ReviewMenu repo={own.repo} number={own.number} row={own} here={{ projectId: project.id, workstream }} agentOnly />
        ) : (
          <AppRouter><LinkButton href="/chat/reviews" variant="primary" className="rv-pick">Pick a PR to review</LinkButton></AppRouter>
        )}
      </div>
    );
  }

  return (
    <div className="rv-pane">
      <div className="rv-pane-head">
        <span className="rv-pane-mark" data-state={pane.state} aria-hidden="true">
          {pane.state === 'reviewing' ? <ProgressBar variant="spinner" size="small" isIndeterminate aria-label="Reading" /> : <Icon name={pane.state === 'done' ? 'check-circle' : pane.state === 'waiting' ? 'warning' : 'cancel-circle'} size="small" />}
        </span>
        <span className="rv-pane-title">
          {pane.reviewer}
          {repo && <> on <Link to={prPath(repo, pane.number)} className="rv-pane-pr">{prShort(repo, pane.number)}</Link></>}
        </span>
        <span className="rv-pane-state">{STATE_WORD[pane.state]}</span>
        {panes.length > 1 && <span className="rv-pill" title={panes.map(p => `#${p.number} ${STATE_WORD[p.state]}`).join('\n')}>{panes.length} reviews</span>}
        <span className="rv-pane-acts">
          {pane.url && <a className="rv-link-button rv-gh" href={pane.url} target="_blank" rel="noopener noreferrer">GitHub<Icon name="link-external" size="small" aria-hidden="true" /></a>}
          {(pane.state === 'reviewing' || pane.state === 'waiting') && (
            <Button size="small" variant="minimal" onPress={() => { void reviewApi.stop(project.id, workstream, pane.session ?? undefined); }}>Stop</Button>
          )}
        </span>
      </div>
      <div className="rv-pane-body chat-transcript-inner" ref={scroller}>
        {capture.error === 'offline' && <p className="rv-note">The box is offline.</p>}
        {blocks.map((b, i) => <BlockView key={i} block={b} agentLabel={pane.reviewer} dialogHint={`${pane.reviewer} is asking · answer below`} />)}
        {blocks.length === 0 && !capture.error && (
          <p className="rv-note">{pane.state === 'exited' ? `${pane.reviewer} exited.` : content == null ? `Reading ${pane.reviewer}'s pane…` : `${pane.reviewer} is starting…`}</p>
        )}
      </div>
      {(choices.length > 0 || keys.length > 0) && (
        <div className="rv-pane-keys" role="toolbar" aria-label={`Answer ${pane.reviewer}`}>
          {choices.map(k => <Button key={k.keys} size="small" variant={k.keys === '1' || k.keys === 'Enter' ? 'primary' : 'default'} onPress={() => { void send(k.keys, k.enter, k.literal); }}>{k.label}</Button>)}
          {choices.length > 0 && keys.length > 0 && <span className="rv-pane-keys-sep" aria-hidden="true" />}
          {keys.map(k => <Button key={`key-${k.keys}`} size="small" variant="default" aria-label={k.title} onPress={() => { void send(k.keys, k.enter, k.literal); }}>{k.label}</Button>)}
        </div>
      )}
      {pane.state === 'exited' && repo && (
        // Exited (a failed start, or the reviewer quit): start it again here, as the empty tab would.
        <div className="rv-handoff">
          <span>{pane.reviewer} exited before it finished.</span>
          <ReviewMenu repo={repo} number={pane.number} row={own && own.number === pane.number ? own : null} here={{ projectId: project.id, workstream }} agentOnly size="small" label="Review again" />
        </div>
      )}
      {ownPr && pane.state === 'done' && (
        <div className="rv-handoff">
          <span>
            {copied ? 'Copied. Paste it into the session\'s message box to talk it through.'
              : copyFailed ? 'Couldn\'t copy it here: select it in the pane instead.'
              : `${pane.reviewer} is done with this session's PR.`}
          </span>
          {!copied && (
            // Not before the pane is read: a copy then would hold no review at all.
            <Button size="small" variant="primary" isDisabled={!parsed || blocks.length === 0} onPress={() => {
              const quote = reviewQuote(pane, own!.repo!, (parsed?.blocks ?? []).map(b => b.text).join('\n\n'));
              navigator.clipboard.writeText(quote).then(() => setCopiedFor(paneKey), () => setCopyFailed(true));
            }}>Copy the review</Button>
          )}
        </div>
      )}
      {sendFailed && <p className="rv-note rv-send-failed" role="alert">That didn't reach {pane.reviewer}. Try it again.</p>}
      <form className="rv-pane-input" onSubmit={e => { e.preventDefault(); const t = text.trim(); if (!t) return; void send(t).then(ok => { if (ok) setText(''); }); }}>
        <TextField aria-label={`Message ${pane.reviewer}`} value={text} onChange={setText} className="rv-pane-field">
          <Label className="chat-sr">Message {pane.reviewer}</Label>
          <Input placeholder={`Message ${pane.reviewer}…`} />
        </TextField>
        <Button type="submit" size="small" variant="default" isDisabled={!text.trim()}>Send</Button>
      </form>
    </div>
  );
}

/**
 * A numbered option list at the foot of a pane: Devin's and Claude's approval
 * prompts. Only the last unbroken run of numbered rows, below at most a hint
 * row or two, and only when one row carries the cursor (❯): a numbered list in
 * the review above it is text, not choices.
 */
export function paneOptions(content: string | null): Array<{ n: string; text: string }> {
  if (!content) return [];
  // The capture is styled: its colours are taken off first, or the cursor (❯) a colour wraps isn't seen.
  // Blank rows stay: one ends a run, so a numbered list in the review just above isn't taken for the choices.
  const rows = content.split('\n').map(l => stripSgr(l).trimEnd());
  const OPTION = /^\s*([❯›>])?\s*(\d)\.\s+(.+)$/;
  let last = rows.length - 1;
  while (last >= 0 && !rows[last]) last--;
  // Below the choices: at most a hint row or two, and the blanks around them.
  let end = last;
  while (end >= 0 && last - end < 4 && !OPTION.test(rows[end])) end--;
  const run: RegExpExecArray[] = [];
  for (let i = end; i >= 0; i--) {
    const m = OPTION.exec(rows[i]);
    if (!m) break;
    run.unshift(m);
  }
  if (!run.some(m => m[1])) return [];
  const out: Array<{ n: string; text: string }> = [];
  for (const m of run) if (!out.some(o => o.n === m[2])) out.push({ n: m[2], text: m[3].replace(/`/g, '').slice(0, 48) });
  return out;
}

// Devin's approval footer as a whole line: "↑↓ select · ↵ confirm", with
// hints between and after in newer builds ("· ↔ scope · e edit"). One star
// before each fixed token, so a line that fails fails in linear time.
const ARROW_FOOTER = /^\s*↑↓\s+select\b[^↵]*·\s*↵\s+confirm\b[^↵]*$/;
const CURSOR_ROW = /^\s*[❭❯›>]\s+(.+)$/;
// A wrapped footer, joined: nothing but short hints ("↔ scope", "e edit",
// "esc cancel") between dots, so a line of review text under the footer is not
// taken for its tail. A hint starts and ends on a non-space, so the dots and
// spaces split one way only.
const HINT = String.raw`[^·\s](?:[^·]{0,18}[^·\s])?`;
const WRAPPED_FOOTER = new RegExp(String.raw`^↑↓\s+select(?:\s*·\s*${HINT})*\s*·\s*↵\s+confirm(?:\s*·\s*${HINT})*$`);

/**
 * Devin's un-numbered approval list (3000.11.234: "❭ Allow ← ■□□□ → Once
 * Exec(gh auth)" over "  Deny", then the footer), whose rows take arrows and
 * Enter, not digits. The footer is the pane's last line, or its last two or
 * three when a narrow pane wraps it. Offered, each one send: the cursor row
 * (Enter), the row under it (Down, Enter), and the Allow row just above a
 * cursor on Deny (Up, Enter). Any other row above the cursor may be the tool
 * call it asks about, and Up from the top row could wrap. Esc cancels.
 */
export function arrowOptions(content: string | null): Array<{ keys: string; label: string; enter: boolean; literal: boolean }> {
  if (!content) return [];
  const rows = content.split('\n').map(l => stripSgr(l).trimEnd());
  let last = rows.length - 1;
  while (last >= 0 && !rows[last]) last--;
  if (last < 1) return [];
  // Where the footer starts: the last line, or up to two more when it wraps.
  let foot = -1;
  for (let k = last; k >= Math.max(0, last - 2) && foot < 0; k--) {
    if (!/^\s*↑↓\s+select\b/.test(rows[k])) continue;
    const joined = rows.slice(k, last + 1).map(r => r.trim()).join(' ');
    if (k === last ? ARROW_FOOTER.test(joined) : WRAPPED_FOOTER.test(joined)) foot = k;
  }
  if (foot < 1) return [];
  // The rows end at a blank or two over the footer, and start at the next blank up.
  let i = foot - 1;
  while (i >= 0 && !rows[i] && foot - i <= 2) i--;
  const above: string[] = [];
  for (; i >= 0 && rows[i] && above.length < 6; i--) above.unshift(rows[i]);
  // Nearest the footer: a quoted `> …` or `❯ …` row higher up is transcript, not the list.
  const at = above.findLastIndex(r => CURSOR_ROW.test(r));
  if (at < 0) return [];
  const label = (r: string) => (CURSOR_ROW.exec(r)?.[1] ?? r).replace(/←\s*[■□]+\s*→/g, ' ').replace(/`/g, '').replace(/\s+/g, ' ').trim().slice(0, 48);
  const out = [{ keys: 'Enter', label: label(above[at]), enter: false, literal: false }];
  if (above[at + 1]) out.push({ keys: 'Down', label: label(above[at + 1]), enter: true, literal: false });
  if (at > 0 && /^\s*Deny\b/.test(label(above[at])) && /^\s+Allow\b/.test(above[at - 1])) {
    out.splice(1, 0, { keys: 'Up', label: label(above[at - 1]), enter: true, literal: false });
  }
  out.push({ keys: 'Escape', label: 'Esc · cancel', enter: false, literal: false });
  return out;
}

type AnswerKey = { keys: string; label: string; enter: boolean; literal: boolean };
type SendBody = { keys: string; enter: boolean; literal: boolean };

/**
 * The send-keys route takes one send per 500 ms per caller and session
 * (routes/sessions.ts) and refuses the rest, so the tab's sends go one at a
 * time, this far apart: the next starts once the last is answered and the gap
 * has passed since it started.
 */
export const SEND_GAP_MS = 600;

/**
 * Keys pressed twice on purpose: ↑↓ to move two rows, Esc twice to interrupt
 * Devin, ^C twice to quit. Any other send repeated while the first is still
 * pending is a double click, and goes once: a second "1" or Enter would answer
 * whatever the reviewer asks next.
 */
const REPEATABLE = new Set(['Up', 'Down', 'Escape', 'C-c']);

/**
 * `sendOne` one at a time, `gapMs` apart; each resolves true once sent, false
 * if it failed. A send the same as one still pending joins it, unless it's a
 * REPEATABLE key.
 */
export function spacedSender(gapMs: number, sendOne: (body: SendBody) => Promise<unknown>): (body: SendBody) => Promise<boolean> {
  let chain: Promise<unknown> = Promise.resolve();
  let last = -Infinity;
  const pending = new Map<string, Promise<boolean>>();
  return body => {
    const repeatable = !body.literal && !body.enter && REPEATABLE.has(body.keys);
    const id = JSON.stringify([body.keys, body.enter, body.literal]);
    const same = repeatable ? undefined : pending.get(id);
    if (same) return same;
    const run = chain.then(async () => {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      last = Date.now();
      await sendOne(body);
      return true;
    }).catch(() => false);
    chain = run;
    if (!repeatable) {
      pending.set(id, run);
      void run.then(() => { if (pending.get(id) === run) pending.delete(id); });
    }
    return run;
  };
}

/**
 * What the tab offers a reviewer to answer with. Its own choices while it
 * waits, read off its list ("❯ 1. Yes (approve once)", Devin's "❭ Allow …"),
 * else its digits. Then the chat's own key bar (quickKeys: Enter, Esc, ↑, ↓,
 * ^C), shown when the chat's would be: while it waits, or a question is on
 * screen the sweep hasn't read as waiting. So a prompt the choices misread
 * can still be answered key by key, as in the session's chat and on the phone.
 */
export function reviewKeys(
  state: AgentReview['state'],
  status: AgentStatusValue,
  content: string | null,
  dialogOptions: number,
  provider: string,
): { choices: AnswerKey[]; keys: QuickKey[] } {
  const waiting = state === 'waiting';
  const listed = waiting ? paneOptions(content) : [];
  const arrowed = waiting && !listed.length ? arrowOptions(content) : [];
  const choices = !waiting ? []
    : listed.length ? listed.map(o => ({ keys: o.n, label: `${o.n} · ${o.text}`, enter: false, literal: true }))
    : arrowed.length ? arrowed
    : answerDigits(provider, dialogOptions);
  // The bar without its digits: the choices above are the reviewer's own.
  const keys = state !== 'exited' && showAnswerKeys(status, dialogOptions) ? quickKeys(null, undefined, null) : [];
  // Its Esc cancels as the list's own "Esc · cancel" would, so that one goes.
  return { choices: keys.length ? choices.filter(c => c.keys !== 'Escape') : choices, keys };
}

/**
 * Digits for a waiting reviewer whose list couldn't be read: quickKeys' own for its provider (a reviewer waits on an
 * approval), else 1–3, since Cursor's waiting has none there and the tab's answer row would be empty.
 */
export function answerDigits(provider: string, options: number): Array<{ keys: string; label: string; enter: boolean; literal: boolean }> {
  const own = quickKeys(provider, 'waiting', 'approval', options).filter(k => /^\d$/.test(k.keys)).slice(0, 3);
  return (own.length ? own.map(k => k.keys) : ['1', '2', '3']).map(n => ({ keys: n, label: n, enter: false, literal: true }));
}

function reviewerId(name: string): string {
  return name.toLowerCase();
}
