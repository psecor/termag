// Tool calls in an SDK chat: one card per call, and a run of consecutive
// calls folded into one row (chat/toolRuns.ts) that opens to its cards.
import React, { useState } from 'react';
import { toolSummary } from '../../chat/sdkChat';
import { alwaysShown, runSummary, type ToolItem } from '../../chat/toolRuns';

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

export function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const { title, detail } = toolSummary(item.name, item.input);
  const state = !item.done ? 'running' : item.isError ? 'error' : 'done';
  if (item.name === 'Skill') return <SkillCard name={detail} text={item.skill ?? item.result} state={state} />;
  const command = item.name === 'Bash' && detail ? `$ ${detail}` : null;
  return (
    <div className="sdk-tool" data-state={state}>
      <button type="button" className="sdk-tool-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="sdk-tool-mark" aria-hidden="true">{state === 'running' ? '◌' : state === 'error' ? '✗' : '✓'}</span>
        <span className="sdk-tool-title">{title}</span>
        {detail && <span className="sdk-tool-detail">{detail}</span>}
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

export function ToolRun({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const summary = runSummary(tools);
  const shown = open ? tools : alwaysShown(tools);
  return (
    <div className="sdk-run" data-state={summary.state} data-open={open || undefined}>
      <button type="button" className="sdk-run-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="sdk-tool-mark" aria-hidden="true">{summary.state === 'running' ? '◌' : summary.state === 'error' ? '✗' : '✓'}</span>
        <span className="sdk-run-title">{summary.text}</span>
        {summary.failed > 0 && (
          <span className="sdk-run-failed" title={summary.state === 'error' ? undefined : 'Later calls went on past these'}>
            {summary.failed} failed
          </span>
        )}
        <span className="sdk-tool-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {shown.length > 0 && (
        <div className="sdk-run-body">
          {shown.map(t => <ToolCard key={t.key} item={t} />)}
        </div>
      )}
    </div>
  );
}
