import React, { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { PaletteLauncher } from '../../components/SearchPalette';
import { buildHome, statusMapFromSessions } from '../../mobile/inbox';
import { useTheme } from '../../theme/ThemeProvider';
import type { SessionRow } from '../../services/api';
import type { Project } from '../../types';
import type { WorkspaceTarget } from '../../utils/workspaceTarget';
import { projectHref } from './AttentionSection';

/**
 * ⌘K on the dashboard: the workspace's palette (sessions, pull requests,
 * pane text), its session rows built from the dashboard's own polls, since
 * this route has no ProjectContext: no status WebSocket, no heartbeat, so
 * searching here still is not working time. A session opens its workstream
 * in the workspace; a pull request opens the PR overlay on this page.
 */
export function DashboardSearch({ sessions, projects, now }: { sessions: SessionRow[] | null; projects: Project[] | null; now: number }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  // The same list the workspace's palette shows: ask chats left out unless
  // Settings → Appearance shows them (utils/askChatVisibility.ts) — the
  // dashboard's ⌘K is a fourth session list, not a fifth opinion.
  const { theme } = useTheme();
  const rows = useMemo(
    () => buildHome(projects ?? [], statusMapFromSessions(sessions ?? []), user?.unixUsername ?? '', { hideAskChats: !theme.sidebarAskChats }).rows,
    [projects, sessions, user?.unixUsername, theme.sidebarAskChats],
  );
  const openTarget = useCallback((t: WorkspaceTarget) => {
    if (t.kind === 'external') window.open(t.url, '_blank', 'noopener');
    else if (t.kind === 'pane') navigate(projectHref(t.projectId, t.workstream));
  }, [navigate]);
  return <PaletteLauncher rows={rows} now={now} openTarget={openTarget} />;
}
