// ⌘K in the simple UI: the workspace's palette (components/SearchPalette.tsx)
// over the sidebar's sessions. A session or pane hit opens its conversation
// here, a pull request opens on GitHub (the simple UI has no PR overlay), and
// each session result carries its box's pill; typing a box's name finds the
// sessions on it.
import React, { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection } from '../../contexts/ConnectionContext';
import { PaletteLauncher } from '../../components/SearchPalette';
import { chatHref } from '../../chat/simpleChat';
import type { InboxRow } from '../../mobile/inbox';
import type { PrRow } from '../../services/api';
import type { WorkspaceTarget } from '../../utils/workspaceTarget';

export function ChatSearch({ rows, now, boxNameOf }: { rows: readonly InboxRow[]; now: number; boxNameOf: (row: InboxRow) => string | null }) {
  // Offline, the takeover covers the page (ConnectionOverlay), as in the workspace.
  const offline = useConnection().state === 'offline';
  const navigate = useNavigate();
  const openTarget = useCallback((t: WorkspaceTarget) => {
    if (t.kind === 'external') window.open(t.url, '_blank', 'noopener');
    else if (t.kind === 'pane') navigate(chatHref(t.projectId, t.workstream));
  }, [navigate]);
  const openPr = useCallback((row: PrRow) => {
    if (row.url) window.open(row.url, '_blank', 'noopener');
  }, []);
  return <PaletteLauncher offline={offline} rows={rows} now={now} openTarget={openTarget} openPr={openPr} boxNameOf={boxNameOf} />;
}
