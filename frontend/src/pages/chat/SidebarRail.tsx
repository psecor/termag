// The redesigned sidebar collapsed to a rail,
// on a desktop width only: Show the sidebar, New session and Search, then Needs
// you with its count, then each of the person's projects as its icon with a
// live dot (amber while one of its sessions needs you, the accent while one
// works). A project's icon opens the sidebar on that project's head
// (chat/revealProject.ts); Needs you opens it on Needs you, unfolded (on Pinned
// when every session that needs you is pinned). The button by the
// brand and ⌘\ (Ctrl+\) collapse and expand it (chat/sidebarRail.ts). Every
// control is LaunchPad's, in termag's colours, with a tooltip and a name that
// says what its dot means.
import { reviewCallKind } from '../../chat/reviews';
import { useYourCallReviews } from './reviewsData';
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, IconButton, Tooltip, TooltipTrigger } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { useProjects } from '../../contexts/ProjectContext';
import { chatLiveKey } from '../../chat/chatLiveStatus';
import { chatRowState, liveUnlessWaiting, type RowStateKind } from '../../chat/rowState';
import { revealProject } from '../../chat/revealProject';
import { useSidebarView } from '../../chat/sidebarView';
import { needsCount, railDot, railLabel, railShortcutLabel, setSidebarCollapsed, useRailProjects } from '../../chat/sidebarRail';
import { LP_THEME } from '../../launchpad/theme';
import { OPEN_PALETTE_EVENT } from '../../utils/searchPalette';
import { ProjectGlyph } from './ProjectGlyph';
import { useSimpleData } from './simpleData';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const RAIL_KEYS = railShortcutLabel(MAC);
export const RAIL_MAC = MAC;

/** Whether `el` is showing: on the rail, or in the sidebar while it isn't collapsed (it stays mounted under the rail). */
const shown = (el: Element) => el.closest('.sb-rail') !== null || el.closest('.chat-sidebar[data-collapsed]') === null;

/** Focus what `selector` names once it's showing: the button that takes the place of the one just pressed. */
export function focusSoon(selector: string) {
  let tries = 0;
  const look = () => {
    const el = [...document.querySelectorAll<HTMLElement>(selector)].find(shown);
    if (el) { el.focus(); return; }
    if (tries++ < 10) window.requestAnimationFrame(look);
  };
  window.requestAnimationFrame(look);
}

/**
 * Open the sidebar, then bring the first of `groups` (list groups' data-group) that's drawn into view, unfolded, with
 * its head focused, as a project's reveal does (chat/revealProject.ts).
 */
function openOn(groups: readonly string[]) {
  setSidebarCollapsed(false);
  let tries = 0;
  const look = () => {
    const head = groups.map(g => document.querySelector<HTMLElement>(`.chat-projects [data-group="${CSS.escape(g)}"]`)).find(h => h && shown(h));
    if (head) {
      const fold = head.querySelector<HTMLElement>('.chat-projects-fold');
      if (fold?.getAttribute('aria-expanded') === 'false') fold.click();
      head.scrollIntoView?.({ block: 'nearest' });
      fold?.focus({ preventScroll: true });
      return;
    }
    if (tries++ < 20) window.requestAnimationFrame(look);
  };
  window.requestAnimationFrame(look);
}

function RailButton({ label, tip, onPress, children, className }: {
  label: string; tip: string; onPress: () => void; children: React.ReactNode; className?: string;
}) {
  return (
    <TooltipTrigger delay={300}>
      <Button variant="minimal" className={`sb-rail-btn ${className ?? ''}`.trim()} aria-label={label} onPress={onPress}>{children}</Button>
      <Tooltip placement="right" className={LP_THEME}>{tip}</Tooltip>
    </TooltipTrigger>
  );
}

export function SidebarRail() {
  const navigate = useNavigate();
  const { projects } = useProjects();
  const { rows, live, setupOf, unseen, userProjects } = useSimpleData();
  const byId = new Map(projects.map(p => [p.id, p]));
  // A review session that's your call lights Needs you, as the list files it (reviewsData.tsx useYourCallReviews).
  const yourCall = useYourCallReviews();
  const kindOf = (r: (typeof rows)[number]): RowStateKind =>
    reviewCallKind(chatRowState(r, liveUnlessWaiting(r, live.get(chatLiveKey(r.projectId, r.workstream))), setupOf.get(r.projectId), unseen.has(r.key)).kind, yourCall.has(r.key));
  // Each of the person's projects, in the order the list has them (most recently active first), with its sessions' states.
  const kindsBy = new Map<string, RowStateKind[]>();
  for (const r of rows) {
    // As the list files them (chat/sidebarGroups.ts sectionOf): a shared session, an automation's run and a cloud
    // session aren't their project's, so they don't light its dot. (Needs you's badge counts them: Needs you lists them.)
    if (r.shared || r.kind === 'automation' || r.kind === 'cloud') continue;
    const up = byId.get(r.projectId)?.userProjectId;
    if (!up) continue;
    kindsBy.set(up, [...(kindsBy.get(up) ?? []), kindOf(r)]);
  }
  // Exactly the projects the list draws a head for, in its order (it stays mounted under the rail and publishes them:
  // ProjectsList.tsx), so an icon always opens on a head; until it has, the person's projects by the view's filter.
  const listed = useRailProjects();
  const { showIdle } = useSidebarView();
  const byUp = new Map((userProjects?.list ?? []).map(p => [p.id, p]));
  const own = listed
    ? listed.flatMap(id => { const p = byUp.get(id); return p && !p.archived ? [p] : []; })
    : (userProjects?.list ?? []).filter(p => !p.archived && (showIdle || (kindsBy.get(p.id) ?? []).some(k => k !== 'off')));
  const needs = needsCount(rows.map(kindOf));
  return (
    <div className={`${LP_THEME} sb-rail`} role="group" aria-label="Sidebar, collapsed">
      <TooltipTrigger delay={300}>
        <IconButton icon="sidebar-left-expand" variant="minimal" className="sb-rail-btn sb-rail-show" aria-label="Show the sidebar"
          aria-keyshortcuts={MAC ? 'Meta+\\' : 'Control+\\'} aria-expanded={false} aria-controls="chat-conversations"
          onPress={() => { setSidebarCollapsed(false); focusSoon('.sb-collapse'); }} />
        <Tooltip placement="right" className={LP_THEME}>Show the sidebar {RAIL_KEYS}</Tooltip>
      </TooltipTrigger>
      <RailButton label="New session" tip="New session" onPress={() => navigate('/chat/new')}>
        <Icon name="edit" size="medium" aria-hidden="true" />
      </RailButton>
      <RailButton label="Search" tip="Search" onPress={() => window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT))}>
        <Icon name="search" size="medium" aria-hidden="true" />
      </RailButton>
      <span className="sb-rail-sep" aria-hidden="true" />
      <RailButton label={needs ? `Needs you, ${needs}` : 'Needs you, none'} tip={needs ? `Needs you: ${needs}` : 'Nothing needs you'}
        className="sb-rail-needs" onPress={() => openOn(needs > 0 ? ['needs-you', 'pinned'] : ['needs-you'])}>
        <Icon name="warning" size="medium" aria-hidden="true" />
        {needs > 0 && <span className="sb-rail-badge" aria-hidden="true">{needs}</span>}
      </RailButton>
      <div className="sb-rail-projects">
        {own.map(p => {
          const kinds = kindsBy.get(p.id) ?? [];
          const dot = railDot(kinds);
          return (
            <RailButton key={p.id} label={railLabel(p.name, kinds)} tip={p.name} className="sb-rail-project" onPress={() => {
              // The list answers the reveal as it mounts (takePendingReveal): its group unfolded, in view, its head focused.
              setSidebarCollapsed(false);
              revealProject(p.id);
            }}>
              <ProjectGlyph repos={p.repos?.map(x => x.repoKey) ?? []} size={20} />
              {dot && <span className="sb-rail-dot" data-dot={dot} aria-hidden="true" />}
            </RailButton>
          );
        })}
      </div>
    </div>
  );
}
