// The session composer's context ring (chat/contextUsage.ts): a round button
// with two rings. The outer one fills with Claude's context window; the inner
// one, there once Claude has reported plan usage, fills with the fullest plan
// window. Each has its own colour, which the popover's bars share, and turns
// amber or red as it fills. Hovering or focusing the button shows the
// numbers; a click pins them until Escape or a click elsewhere. The popover
// is not a dialog: the session's Escape-to-stop (SdkChatView) stands down
// while a dialog is open, and a glance at the ring must not take Escape from
// a running turn. Escape on a pinned popover, or one the keyboard opened,
// closes it and goes no further. A plan
// window's status can colour the inner ring too: an Enterprise seat's
// extra-usage window has no utilization, only allowed, allowed_warning or
// rejected.
//
// Compact and Clear (agent chat-context-v1) sit under the numbers when the
// session offers them: opening the popover and clicking one is the whole
// interaction, with no confirm. A clear can be taken back: until the next
// message, Resume puts the cleared session back. They are the app's small
// buttons (btn-tiny, as the chat's Retry, Trust and Send/Discard), each with
// its explanation, or why it is disabled, in its tooltip. A button only ever
// looks enabled or disabled: enabled wears btn-tiny's own hover look at rest
// (chat.css), and what cannot apply is hidden, not disabled: Resume whenever
// it cannot be used, Compact or Clear where this chat can never do them. The popover keeps
// one layout whatever it holds (every line is one line, the meter is always
// there, the actions are one row), so it never resizes under the pointer.
import React, { useEffect, useId, useRef, useState } from 'react';
import { formatCost, type ActionState, type ContextAction } from './sdkChat';
import {
  contextView, emptyUsage, formatTokens, planPercent, planTone, resetText, ringLabel, ringTone, shownWindows, statusTone, windowLabel,
  windowPercent, windowValue, type ChatUsage, type RingTone,
} from './contextUsage';

const SIZE = 20;
const STROKE = 2.25;
const GAP = 1;
const OUTER_R = (SIZE - STROKE) / 2;
const INNER_R = OUTER_R - STROKE - GAP;

/** Which ring a bar or an arc belongs to, for its colour. */
type RingKind = 'context' | 'plan';

/** One ring: its track, and an arc from twelve o'clock for the percent. */
function Ring({ r, kind, percent, tone }: { r: number; kind: RingKind; percent: number | null; tone: RingTone }) {
  const circumference = 2 * Math.PI * r;
  const fill = Math.min(100, percent ?? 0);
  // The arc stays mounted at zero, faded out, so a clear or a compact winds it down instead of dropping it in one frame.
  return (
    <>
      <circle className="chat-ring-track" data-kind={kind} data-tone={fill > 0 || tone === 'ok' ? undefined : tone} cx={SIZE / 2} cy={SIZE / 2} r={r} fill="none" strokeWidth={STROKE} />
      <circle
        className="chat-ring-arc" data-kind={kind} data-tone={tone} data-empty={fill > 0 ? undefined : ''}
        cx={SIZE / 2} cy={SIZE / 2} r={r} fill="none" strokeWidth={STROKE} strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={circumference * (1 - fill / 100)}
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
      />
    </>
  );
}

/** A row's label: one line, cut with an ellipsis when the popover is too narrow, its full text the tooltip. */
function RowLabel({ text }: { text: string }) {
  return <span className="chat-ring-row-label" title={text}>{text}</span>;
}

function Meter({ kind, percent, tone }: { kind: RingKind; percent: number; tone: RingTone }) {
  return (
    <div className="chat-ring-meter" data-kind={kind} data-tone={tone} aria-hidden="true">
      <i style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

/** The popover's actions: shown only when the session offers them (chat/sdkChat.ts contextActions). */
export interface ContextControls {
  /** null: this chat can never do it, so it is not shown. */
  clear: ActionState | null;
  compact: ActionState | null;
  /** Resume previous context is on offer: a clear, and no message since. */
  resume: boolean;
  /** The action on its way to the box. */
  busy?: ContextAction | null;
  onAction: (action: ContextAction) => void;
}

export function ContextRing({ usage = emptyUsage, costUsd, sinceClearedUsd = null, compactedFrom = null, actions = null, now = Date.now }: {
  usage?: ChatUsage;
  /** The whole chat, across clears: it never goes down. */
  costUsd: number | null;
  /** Since the context was last cleared (chat/sdkChat.ts costSinceCleared); null when it never was. */
  sinceClearedUsd?: number | null;
  /** The context the last compaction started from, until a reply says the new size. */
  compactedFrom?: number | null;
  actions?: ContextControls | null;
  /** The clock, for the reset times (tests pass a fixed one). */
  now?: () => number;
}) {
  const [pinned, setPinned] = useState(false);
  const [peek, setPeek] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  const open = pinned || peek;

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) { setPinned(false); setPeek(false); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A pinned or focused popover takes the Escape; a hover peek only closes and lets it through.
      if (pinned || rootRef.current?.contains(document.activeElement)) e.preventDefault();
      setPinned(false);
      setPeek(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, pinned]);

  const ctx = contextView(usage);
  const windows = shownWindows(usage.limits);

  return (
    <div className="chat-ring" ref={rootRef} onMouseEnter={() => setPeek(true)} onMouseLeave={() => setPeek(false)}>
      <button
        type="button"
        className="chat-icon-btn chat-ring-btn"
        aria-label={ringLabel(usage)}
        aria-expanded={open}
        aria-controls={popId}
        onClick={() => setPinned(p => !p)}
        onFocus={() => setPeek(true)}
        onBlur={e => { if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setPeek(false); }}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          <Ring r={OUTER_R} kind="context" percent={ctx?.percent ?? null} tone={ringTone(ctx?.percent ?? null)} />
          {windows.length > 0 && <Ring r={INNER_R} kind="plan" percent={planPercent(usage)} tone={planTone(usage)} />}
        </svg>
      </button>
      {open && (
        <div className="chat-ring-pop" id={popId} role="group" aria-label="Context and usage">
          <div className="chat-ring-head">Context</div>
          <div className="chat-ring-sub">
            {ctx ? `${formatTokens(ctx.used)} of ${formatTokens(ctx.window)} tokens · ${ctx.percent}%`
              : compactedFrom != null ? `Compacted from ${formatTokens(compactedFrom)} tokens` : "Fills in with Claude's next reply"}
          </div>
          <Meter kind="context" percent={ctx?.percent ?? 0} tone={ringTone(ctx?.percent ?? null)} />
          {costUsd != null && (
            <div className="chat-ring-row">
              <RowLabel text={`This chat${sinceClearedUsd != null ? ` · ${formatCost(sinceClearedUsd)} since cleared` : ''}`} />
              <b>{formatCost(costUsd)}</b>
            </div>
          )}
          {actions && <ContextActions actions={actions} />}
          {windows.length > 0 && (
            <>
              <hr className="chat-ring-sep" />
              <div className="chat-ring-head">Plan usage</div>
              {windows.map(([type, w]) => {
                const p = windowPercent(w);
                const said = statusTone(w);
                return (
                  <div key={type} className="chat-ring-window">
                    <div className="chat-ring-row">
                      <RowLabel text={windowLabel(type)} />
                      <b data-tone={said === 'ok' ? undefined : said}>{windowValue(w)}</b>
                    </div>
                    {p != null && <Meter kind="plan" percent={p} tone={said === 'danger' ? 'danger' : ringTone(p)} />}
                    {(w.detail || w.resetsAt != null) && (
                      <div className="chat-ring-note">{[w.detail, w.resetsAt != null ? resetText(w.resetsAt, now()) : null].filter(Boolean).join(' · ')}</div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const COMPACT_TIP = 'Summarise the conversation and go on from the summary (uses a turn)';
const CLEAR_TIP = 'Start the next message with an empty context';
const RESUME_TIP = 'Resume previous context: undo the clear (until you send a message)';

/**
 * One row: Compact and Clear, then Resume while a clear can be taken back.
 * Resume comes last, so the other two never move under the pointer when it
 * comes or goes; it hides while another action is on its way. Labels never
 * change; a busy action disables Compact and Clear.
 */
function ContextActions({ actions }: { actions: ContextControls }) {
  const { clear, compact, resume, busy, onAction } = actions;
  const tip = (a: ActionState, why: string) => (a.enabled ? why : a.reason ?? why);
  if (!clear && !compact && !resume) return null;
  return (
    <>
      <hr className="chat-ring-sep" />
      <div className="chat-ring-actions" aria-busy={busy != null || undefined}>
        {compact && (
          <button type="button" className="btn-tiny chat-ring-compact" disabled={!compact.enabled || busy != null} title={tip(compact, COMPACT_TIP)} onClick={() => onAction('compact')}>Compact</button>
        )}
        {clear && (
          <button type="button" className="btn-tiny chat-ring-clear" disabled={!clear.enabled || busy != null} title={tip(clear, CLEAR_TIP)} onClick={() => onAction('clear')}>Clear</button>
        )}
        {resume && busy == null && (
          <button type="button" className="btn-tiny chat-ring-resume" title={RESUME_TIP} onClick={() => onAction('resume')}>Resume</button>
        )}
      </div>
    </>
  );
}
