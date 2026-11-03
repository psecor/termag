// Tool calls in an SDK chat: one card per call, led by what the call says it
// is for, and a run of consecutive calls folded into one row
// (chat/toolRuns.ts) that opens to its cards.
import React, { useContext, useEffect, useRef, useState } from 'react';
import { RunTime, ToolTime } from './ChatTimes';
import { toolSummary } from '../../chat/sdkChat';
import { useToolGroupAnswer } from '../../chat/toolGroupHeadings';
import { alwaysShown, runHeading, runSummary, toolIntent, type ToolItem } from '../../chat/toolRuns';
import { AgentCallRow, isAgentRow, SubagentsContext } from './Subagents';
import { AskCallRow, AsksContext, AsksLine, isAskRow } from './Asks';

/**
 * A skill Claude loaded, as one closed row: "Used skill `termag-spaces`".
 * Its instructions (the SKILL.md Claude Code feeds it) open underneath.
 */
export function SkillCard({ name, text, state = 'done' }: { name: string | null; text: string | null; state?: 'running' | 'error' | 'done' }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sdk-tool sdk-skill" data-state={state}>
      <button type="button" className="sdk-tool-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="sdk-tool-mark" aria-hidden="true">{state === 'running' ? '◌' : state === 'error' ? '✗' : '✓'}</span>
        <span className="sdk-tool-title">{state === 'running' ? 'Loading skill' : state === 'error' ? 'Skill failed' : 'Used skill'}</span>
        {name && <code className="sdk-skill-name">{name}</code>}
        <span className="sdk-tool-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="sdk-tool-body">
          {text ? <pre className="sdk-tool-result">{text}</pre> : <div className="sdk-tool-note">No instructions came back</div>}
        </div>
      )}
    </div>
  );
}

const BACKGROUND_LABEL: Record<NonNullable<ToolItem['background']>, { mark: string; text: string }> = {
  running: { mark: '◐', text: 'running in background' },
  done: { mark: '✓', text: 'finished in background' },
  failed: { mark: '✗', text: 'failed in background' },
  stopped: { mark: '–', text: 'ended with the turn' },
};

export function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  // With subagents on, an Agent call is its subagent's row (Subagents.tsx).
  const agents = useContext(SubagentsContext);
  // And a `termag ask` call is the row of the ask it sent (Asks.tsx).
  const asks = useContext(AsksContext);
  if (agents && isAgentRow(agents, item)) return <AgentCallRow item={item} ui={agents} />;
  if (asks && isAskRow(asks, item)) return <AskCallRow item={item} ui={asks} />;
  const { title, detail } = toolSummary(item.name, item.input);
  const state = !item.done ? 'running' : item.isError ? 'error' : 'done';
  if (item.name === 'Skill') return <SkillCard name={detail} text={item.skill ?? item.result} state={state} />;
  const command = item.name === 'Bash' && detail ? `$ ${detail}` : null;
  // The call's own description leads; the command or path it ran stays beside it.
  const intent = toolIntent(item);
  const secondary = detail === intent ? null : detail;
  // A background call's result only says it started: the card follows the task.
  const bg = state === 'done' && item.background ? BACKGROUND_LABEL[item.background] : null;
  return (
    <div className="sdk-tool" data-state={state} data-intent={intent ? true : undefined} data-background={item.background}>
      <button type="button" className="sdk-tool-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="sdk-tool-mark" aria-hidden="true">{state === 'running' ? '◌' : state === 'error' ? '✗' : bg ? bg.mark : '✓'}</span>
        <span className="sdk-tool-title">{title}</span>
        {intent && <span className="sdk-tool-intent">{intent}</span>}
        {secondary && <span className="sdk-tool-detail" title={secondary}>{secondary}</span>}
        {bg && <span className="sdk-tool-bg">{bg.text}</span>}
        <ToolTime item={item} />
        <span className="sdk-tool-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="sdk-tool-body">
          {command ? <pre className="sdk-tool-input">{command}</pre>
            : <pre className="sdk-tool-input">{JSON.stringify(item.input, null, 2)}</pre>}
          {item.result != null && <pre className="sdk-tool-result">{item.result || '(no output)'}</pre>}
          {item.result == null && item.done && <div className="sdk-tool-note">No result (the turn was stopped)</div>}
        </div>
      )}
    </div>
  );
}

/** How long a live run waits for the box's answer before it takes its fallback; the box gives up first (20 s). */
export const HEADING_WAIT_MS = 30_000;

/**
 * `leadIn`: the assistant text just before the run, its heading when Haiku's
 * has failed or is off.
 * `settled`: no more calls can join the run (something follows it, or the
 * turn is over). Until then the step going on shows on a muted line under
 * the heading.
 * `live`: the run is in the turn running now. `asks`: the box is asking
 * Haiku for that turn's headings (its turn-start said so: never for an ask's
 * turn, a box from before them, or a sender with the flag off). Only a live
 * run of such a turn waits for its answer, on a placeholder, and the wait is
 * the run's (the store's clock, from the first time this page waited on it),
 * so it never lasts longer than HEADING_WAIT_MS however often the transcript
 * is redrawn, and it goes on past the turn's end, since the ask is already
 * out. Anything else takes the fallback at once.
 *
 * The heading line is written once: the first words it shows stay, kept in
 * the store for every later ToolRun of the run, and on a reload (the box keeps
 * its answer, and a failure with its calls, so the same words come back).
 */
export function ToolRun({ runKey, tools, leadIn = null, settled = true, live = false, asks = true }: {
  runKey: string; tools: ToolItem[]; leadIn?: string | null; settled?: boolean; live?: boolean; asks?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { store, headingsOn, answer } = useToolGroupAnswer(runKey);
  const at = Date.now();
  const unanswered = store != null && answer == null;
  const since = unanswered ? store.waitSince(runKey, live && asks ? at : undefined) : null;
  const left = since == null ? 0 : since + HEADING_WAIT_MS - at;
  const waiting = unanswered && left > 0;
  // Redraw once the wait is over, so its fallback shows.
  const [, wake] = useState(0);
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setTimeout(() => wake(n => n + 1), left);
    return () => clearTimeout(timer);
  }, [waiting, left > 0, since]);
  const summary = runSummary(tools);
  const now = runHeading(tools, { leadIn, headingsOn, answer, pending: waiting });
  // Kept from the first time it has words. Without Haiku's headings the lead-in
  // or labels follow the run as before; with them, nothing replaces them.
  const placeholderShown = useRef(false);
  if (now.text == null) placeholderShown.current = true;
  if (store && !store.chosen(runKey) && now.text != null) store.choose(runKey, { text: now.text, source: now.source });
  const line = store ? store.chosen(runKey) : (now.text != null ? { text: now.text, source: now.source } : null);
  // Words that replace the placeholder fade in, once; words there from the first render (a reload) just show.
  const fadeIn = line != null && placeholderShown.current;
  const stepShown = !settled || summary.running > 0;
  // A subagent's row shows with the run shut too: it is where its transcript opens.
  const agents = useContext(SubagentsContext);
  // A run's asks fold into one quiet line while it is shut, and are their own rows once it is open.
  const askUi = useContext(AsksContext);
  const askCalls = askUi && !open ? tools.filter(t => isAskRow(askUi, t)) : [];
  const pinned = alwaysShown(tools).filter(t => !askCalls.includes(t));
  const shown = open ? tools : agents ? tools.filter(t => isAgentRow(agents, t) || pinned.includes(t)) : pinned;
  return (
    <div className="sdk-run" data-state={summary.state} data-source={line?.source ?? 'pending'} data-open={open || undefined}>
      <button type="button" className="sdk-run-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="sdk-tool-mark" aria-hidden="true">{summary.state === 'running' ? '◌' : summary.state === 'error' ? '✗' : '✓'}</span>
        <span className="sdk-run-text">
          {line
            ? <span className="sdk-run-title" data-swapped={fadeIn || undefined} title={line.text === summary.counts ? undefined : summary.counts}>{line.text}</span>
            : <span className="sdk-run-title sdk-run-placeholder" aria-label="Writing a heading" />}
          {stepShown && summary.step && <span className="sdk-run-step">{summary.step}</span>}
        </span>
        {summary.failed > 0 && (
          <span className="sdk-run-failed" title={summary.state === 'error' ? undefined : 'Later calls went on past these'}>
            {summary.failed} failed
          </span>
        )}
        <RunTime tools={tools} />
        <span className="sdk-tool-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {(shown.length > 0 || askCalls.length > 0) && (
        <div className="sdk-run-body">
          {shown.map(t => <ToolCard key={t.key} item={t} />)}
          {askUi && askCalls.length > 0 && <AsksLine items={askCalls} ui={askUi} />}
        </div>
      )}
    </div>
  );
}
