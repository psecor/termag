// When things happened, in an SDK chat's transcript (chat/chatTimes.ts): a
// reply's end beside its cost, a tool call's duration and end, a run's span,
// all muted and shown on hover, with the full timestamp and its zone on hover
// over the time. The one thing always shown is a running call's live counter.
// The full timestamp is the chat's own hover bubble (`data-tip`, Tooltips.tsx),
// as for the transcript's other hover text: a time is not a control, and a
// call's sits inside its head button, where no LaunchPad trigger can go.
import React, { useEffect, useState } from 'react';
import { formatElapsed, fullSpan, fullTime, shortSpan, shortTime, spanText, timeMs } from '../../chat/chatTimes';
import { turnMeta, type TurnCost } from '../../chat/sdkChat';
import type { ToolItem } from '../../chat/toolRuns';

/** The time now, ticking every `every` ms while `on`: a running call's counter. */
export function useNow(on: boolean, every = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [on, every]);
  return now;
}

/**
 * A time with its full timestamp on hover. `focusable`: a tab stop, whose
 * focus shows the stamp too (a reply's, one per reply); a call's is inside
 * its head button, which keyboard focus already reaches.
 */
function TimeTip({ iso, tip, focusable = false, children }: { iso: string; tip: string; focusable?: boolean; children: React.ReactNode }) {
  return <time className="sdk-time-at" dateTime={iso} data-tip={tip} tabIndex={focusable ? 0 : undefined}>{children}</time>;
}

const about = (guessed: boolean | undefined) => (guessed ? 'about ' : '');

/** A reply's muted footnote: "$0.14 · 9s · 18:14", the time's full stamp on hover. */
export function ReplyMeta({ cost }: { cost: TurnCost | undefined }) {
  const meta = cost ? turnMeta(cost) : null;
  const end = cost?.endedAt && timeMs(cost.endedAt) != null ? cost.endedAt : null;
  if (!meta && !end) return null;
  return (
    <div className="sdk-reply-meta">
      {meta}
      {meta && end && ' · '}
      {end && <TimeTip iso={end} tip={`Ended ${fullTime(end)}`} focusable>{shortTime(end)}</TimeTip>}
    </div>
  );
}

/**
 * A call's times, over the right of its head row (inside its head button, so
 * a click there opens the card as anywhere on the row): while it runs, a quiet
 * live counter ("running 12m"); once done, its duration and end on hover
 * ("4s · 18:14"). A call sent to the background counts on while its task
 * runs; its end is the task's, which nothing times, so then only its start.
 */
export function ToolTime({ item }: { item: ToolItem }) {
  const running = !item.done || item.background === 'running';
  const now = useNow(running && !!item.startedAt);
  const start = item.startedAt && timeMs(item.startedAt) != null ? item.startedAt : null;
  const end = item.endedAt && timeMs(item.endedAt) != null ? item.endedAt : null;
  if (running) {
    if (!start) return null;
    return (
      <span className="sdk-tool-time" data-live="">
        <TimeTip iso={start} tip={`Started ${about(item.startGuessed)}${fullTime(start)}`}>
          running {formatElapsed(now - timeMs(start)!)}
        </TimeTip>
      </span>
    );
  }
  if (item.background) {
    if (!start) return null;
    return (
      <span className="sdk-tool-time">
        <TimeTip iso={start} tip={`Started ${about(item.startGuessed)}${fullTime(start)}`}>started {shortTime(start)}</TimeTip>
      </span>
    );
  }
  if (!end) return null;
  const took = spanText(start, end);
  const guessed = item.startGuessed || item.endGuessed;
  return (
    <span className="sdk-tool-time">
      <TimeTip iso={end} tip={`Ended ${about(item.endGuessed)}${fullTime(end)}${took ? `, after ${about(guessed)}${took}` : ''}`}>
        {took ? `${took} · ` : ''}{shortTime(end)}
      </TimeTip>
    </span>
  );
}

/**
 * A run's span on hover, over the right of its heading: "18:02–18:14 · 11m 54s",
 * the full times on hover over it. A run still going says since when, and
 * one with a call sent to the background only when it started.
 */
export function RunTime({ tools }: { tools: readonly ToolItem[] }) {
  const starts = tools.map(t => t.startedAt).filter((t): t is string => !!t && timeMs(t) != null);
  const start = starts.length ? starts.reduce((a, b) => (b < a ? b : a)) : null;
  if (!start) return null;
  const going = tools.some(t => !t.done || t.background === 'running');
  // A call sent to the background ended, as far as its endedAt says, when it was sent; its
  // task's end has no time. A run with one has no end to show, only its start, as its card does.
  const startTip = `Started ${about(tools.find(t => t.startedAt === start)?.startGuessed)}${fullTime(start)}`;
  if (!going && tools.some(t => t.background)) {
    return <span className="sdk-run-time"><TimeTip iso={start} tip={startTip}>started {shortTime(start)}</TimeTip></span>;
  }
  const ends = tools.map(t => t.endedAt).filter((t): t is string => !!t && timeMs(t) != null);
  const end = !going && ends.length ? ends.reduce((a, b) => (b > a ? b : a)) : null;
  const guessed = tools.some(t => t.startGuessed || t.endGuessed);
  if (!end) {
    return (
      <span className="sdk-run-time">
        <TimeTip iso={start} tip={startTip}>since {shortTime(start)}</TimeTip>
      </span>
    );
  }
  const took = spanText(start, end);
  const tip = `${guessed ? 'About ' : ''}${fullSpan(start, end)}${took ? `, ${took} in all` : ''}`;
  return (
    <span className="sdk-run-time">
      <TimeTip iso={start} tip={tip}>
        {shortSpan(start, end)}{took ? ` · ${took}` : ''}
      </TimeTip>
    </span>
  );
}
