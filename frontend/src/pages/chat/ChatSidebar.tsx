// The simple UI's conversation list: every project workstream with an agent,
// the ones that need you first, each with the words for its state and the
// agent's last message, and the way to a new chat.
import React, { useMemo } from 'react';
import { Link, useMatch, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useProjects } from '../../contexts/ProjectContext';
import { buildRows, stateSince, STATUS_GLYPH, statusLabel } from '../../mobile/inbox';
import { fmtAge } from '../../utils/format';
import { chatHref, chatRows, fullUiHref } from '../../chat/simpleChat';

export function ChatSidebar() {
  const { user } = useAuth();
  const { projects, statusMap } = useProjects();
  const match = useMatch('/chat/p/:projectId');
  const [params] = useSearchParams();
  const activeId = match?.params.projectId ?? null;
  const activeWs = params.get('ws') || 'main';

  const rows = useMemo(
    () => chatRows(buildRows(projects, statusMap, user?.unixUsername ?? '')),
    [projects, statusMap, user?.unixUsername],
  );
  const now = Date.now();

  return (
    <nav className="chat-sidebar" aria-label="Conversations">
      <div className="chat-sidebar-head">
        <Link to="/chat" className="chat-brand">termag</Link>
        <Link to="/chat/new" className="btn-primary chat-new">New chat</Link>
      </div>
      <ul className="chat-list">
        {rows.length === 0 && <li className="chat-list-empty">No conversations yet.</li>}
        {rows.map(r => {
          const since = stateSince(r);
          const active = r.projectId === activeId && r.workstream === activeWs;
          return (
            <li key={r.key}>
              <Link
                to={chatHref(r.projectId, r.workstream)}
                className={`chat-row${active ? ' active' : ''}`}
                aria-current={active ? 'page' : undefined}
                data-band={r.band}
              >
                <span className="chat-glyph" data-status={r.status} aria-hidden="true">{STATUS_GLYPH[r.status]}</span>
                <span className="chat-row-body">
                  <span className="chat-row-top">
                    <span className="chat-row-name">
                      {r.projectName}{r.workstream !== 'main' && <span className="chat-row-ws"> · {r.workstream}</span>}
                    </span>
                    {since && <span className="chat-row-age">{fmtAge(now - new Date(since).getTime())}</span>}
                  </span>
                  <span className="chat-row-state">{statusLabel(r)}</span>
                  {r.message && <span className="chat-row-msg">{r.message}</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="chat-sidebar-foot">
        <Link to={fullUiHref(activeId, activeWs)} className="chat-foot-link">Full UI</Link>
        <Link to="/settings" className="chat-foot-link">Settings</Link>
      </div>
    </nav>
  );
}
