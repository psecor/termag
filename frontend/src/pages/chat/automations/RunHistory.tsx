// An automation's run history on its simple-UI page (AutomationDetail.tsx):
// newest first, each row its state, occurrence, trigger, duration and cost,
// what it changed and its summary, its PR or branch, and a ⋮ menu (Open
// conversation, Stop while live, Retire once finished, for the owner). The
// row opens the run's conversation, /chat/p/<project>?ws=<run>. A failed
// load shows inline here and keeps the rest of the page.
import React from 'react';
import { Link } from 'react-router-dom';
import type { AutomationRunView } from '../../../services/api';
import { isLiveRun, runRowText } from '../../../chat/automationsView';
import { chatHref } from '../../../chat/simpleChat';
import { MenuButton, useContextMenu, type MenuAction } from '../ContextMenu';
import { ChatError } from '../TranscriptNotices';
import { RunStateChip } from './StateChip';

export interface RunActions {
  stop: (run: AutomationRunView) => void;
  retire: (run: AutomationRunView) => void;
}

export function RunHistory({ runs, error, onRetry, projectId, timezone, owner, busy, actions, open }: {
  /** Null while the first load is out (or failed). */
  runs: AutomationRunView[] | null;
  error: string | null;
  onRetry: () => void;
  projectId: string;
  timezone: string;
  owner: boolean;
  busy: boolean;
  actions: RunActions;
  /** Navigate to a run's conversation (the menu's Open conversation). */
  open: (href: string) => void;
}) {
  const menu = useContextMenu();
  return (
    <div className="chat-auto-card" aria-label="Run history" role="region">
      <h2>Runs</h2>
      {error && <ChatError text={runs ? `Could not refresh the runs: ${error}` : `Could not load the runs: ${error}`} onRetry={onRetry} />}
      {runs === null ? (!error && <p className="chat-auto-dim">Loading…</p>)
        : runs.length === 0 ? <p className="chat-auto-dim">No runs yet. Each run is a session here{owner ? '; Run now starts one.' : '.'}</p>
          : (
            <ul className="chat-auto-runs">
              {runs.map(r => {
                const t = runRowText(r, timezone);
                const href = r.workstream ? chatHref(projectId, r.workstream) : null;
                const live = isLiveRun(r);
                const items: MenuAction[] = [];
                if (href) items.push({ label: 'Open conversation', onSelect: () => open(href) });
                if (owner && live) items.push({ label: 'Stop', onSelect: () => actions.stop(r), disabled: busy });
                if (owner && r.workstream && !live) items.push({ label: 'Retire', hint: "Remove the run's worktree and branch; the row stays", onSelect: () => actions.retire(r), disabled: busy });
                const body = (
                  <>
                    <span className="chat-auto-line">
                      <RunStateChip state={r.state} label={t.state} />
                      <span className="chat-auto-name">{t.when}</span>
                      <span className="chat-auto-dim">{t.trigger}</span>
                      {t.took && <span className="chat-auto-dim chat-auto-took">{t.took}</span>}
                    </span>
                    {(r.summary || t.changes) && (
                      <span className="chat-auto-sub" title={r.summary ?? undefined}>{[t.changes, r.summary].filter(Boolean).join(' · ')}</span>
                    )}
                  </>
                );
                return (
                  <li key={r.id} className="chat-auto-item" data-live={live || undefined}>
                    {href ? <Link to={href} className="chat-auto-link">{body}</Link> : <div className="chat-auto-link">{body}</div>}
                    {r.prUrl ? <a className="chat-auto-pr" href={r.prUrl} target="_blank" rel="noreferrer">PR</a>
                      : r.branch ? <code className="chat-auto-branch" title={r.branch}>{r.branch.split('/').pop()}</code> : null}
                    {items.length > 0 && (
                      <MenuButton label={`run ${t.when}`} expanded={menu.openKey === r.id}
                        open={e => menu.open(e, `Run ${t.when}`, items, r.id)} />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
      {menu.menu}
    </div>
  );
}
