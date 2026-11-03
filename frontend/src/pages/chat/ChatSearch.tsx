// ⌘K in the simple UI: the workspace's palette (components/SearchPalette.tsx)
// over the sidebar's sessions. A session or pane hit opens its conversation
// here, a pull request opens on GitHub (the simple UI has no PR overlay), and
// each session result carries its box's pill; typing a box's name finds the
// sessions on it. Under the chrome refresh, ChatPalette draws it with
// LaunchPad, a session is called and found by its title as in the sidebar,
// and it lists the simple UI's commands (chatCommands.ts).
import React, { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection } from '../../contexts/ConnectionContext';
import { PaletteLauncher } from '../../components/SearchPalette';
import { chatHref } from '../../chat/simpleChat';
import type { InboxRow } from '../../mobile/inbox';
import type { PrRow } from '../../services/api';
import type { PaletteAction } from '../../utils/searchPalette';
import type { WorkspaceTarget } from '../../utils/workspaceTarget';
import { useChatChrome } from './chatChrome';
import { ChatPalette, paletteNameOf } from './ChatPalette';
import { useSimpleDataIfAny } from './simpleData';
import { useReviewsData } from './reviewsData';
import { prPath } from '../../chat/reviews';

export function ChatSearch({ rows, now, boxNameOf, actions }: {
  rows: readonly InboxRow[]; now: number; boxNameOf: (row: InboxRow) => string | null;
  /** ⌘K's commands (chatCommands.ts), under the refresh. */
  actions?: PaletteAction[];
}) {
  // Offline, the takeover covers the page (ConnectionOverlay), as in the workspace.
  const offline = useConnection().state === 'offline';
  const navigate = useNavigate();
  const { refresh } = useChatChrome();
  const titlesShown = useSimpleDataIfAny()?.titlesShown ?? false;
  const nameOf = useMemo(() => (refresh ? paletteNameOf(titlesShown) : undefined), [refresh, titlesShown]);
  const openTarget = useCallback((t: WorkspaceTarget) => {
    if (t.kind === 'external') window.open(t.url, '_blank', 'noopener');
    else if (t.kind === 'pane') navigate(chatHref(t.projectId, t.workstream));
  }, [navigate]);
  // With reviews on, a PR opens its page here; else GitHub, as before.
  const reviewsOn = useReviewsData().on;
  const openPr = useCallback((row: PrRow) => {
    if (reviewsOn && row.kind === 'pr' && row.repo && row.number != null) navigate(prPath(row.repo, row.number));
    else if (row.url) window.open(row.url, '_blank', 'noopener');
  }, [navigate, reviewsOn]);
  return (
    <PaletteLauncher
      actions={actions}
      offline={offline}
      rows={rows}
      now={now}
      openTarget={openTarget}
      openPr={openPr}
      boxNameOf={boxNameOf}
      nameOf={nameOf}
      view={refresh ? ChatPalette : undefined}
    />
  );
}
