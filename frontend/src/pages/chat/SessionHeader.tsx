// A session's header under the chrome refresh,
// on a desktop width: the space and the session's title (chat/sessionTitle.ts) as
// a breadcrumb, the project as a chip when the title isn't its name, the repo, the
// branch as a chip when it isn't the default, and a Working pill during a turn; then
// the box, a LaunchPad ⋯ menu (Open in Lab, Open in termag desktop, Resize box, Archive) and the panel toggle.
// Under user-projects-enabled, a
// session whose checkout has a project leads with project ▸ title instead: the
// project's name reveals its group in the sidebar (ProjectCrumb), then the
// branch when it isn't the default and the session's PR; the box stays on the
// right. No space, checkout or repo chip: the project says it, and the context
// card still lists the repositories. One without a project yet reads as before.
// The cost is not here: the composer's usage ring has it. The phone's one-row
// header is SdkChatView's own; it shows ProjectCrumb too.
import React from 'react';
import { Button, IconButton, Link as LpLink, Menu, MenuItem, MenuTrigger, Popover, ProgressBar, Text } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import type { Instance, Project } from '../../types';
import { LP_THEME } from '../../launchpad/theme';
import { ChatBoxTag } from './ChatBoxTag';
import { SidePanelButton, useChatChrome } from './chatChrome';
import { ChatSpaceChip } from './SpaceSwatch';
import { Link } from 'react-router-dom';
import { prShort } from '../../chat/reviews';
import { useReviewOf } from './reviewsData';
import { desktopSessionHref } from '../../chat/desktopLinks';
import { branchChip, workstreamTitle } from '../../chat/sessionTitle';
import { revealProject } from '../../chat/revealProject';
import { setSidebarView, useSidebarView } from '../../chat/sidebarView';
import { FLAGS, useFlag } from '../../flags';
import { showProjectFiles } from './FilesTool';
import { useSimpleDataIfAny, type OwnProject } from './simpleData';
import { useSessionPrRow } from './useSessionPr';

/**
 * The checkout's project, under user-projects-enabled, once the page has read
 * the person's projects (simpleData.tsx); null without one, so the header
 * reads as before.
 */
export function useOwnProject(projectId: string): OwnProject | null {
  const on = useFlag(FLAGS.userProjects, false);
  const data = useSimpleDataIfAny();
  return on ? data?.userProjectOf?.(projectId) ?? null : null;
}

/**
 * The project's name ahead of a session's title, and the ▸ after it: a link
 * that reveals the project's group in the sidebar (chat/revealProject.ts),
 * opening the sidebar first where it is a drawer (a phone, a narrow window),
 * and switching it from Tabs to Projects under the refresh, where project
 * groups are. Truncates before the title does (chrome.css, chat.css).
 */
export function ProjectCrumb({ project }: { project: OwnProject }) {
  const { mode, openHistory, refresh } = useChatChrome();
  const view = useSidebarView();
  return (
    <>
      <LpLink className="chat-title-crumb" data-tip={`Show ${project.name} in the sidebar`}
        onPress={() => {
          if (mode === 'drawer') openHistory();
          if (refresh && view.show !== 'projects') setSidebarView({ show: 'projects' });
          revealProject(project.id);
        }}>
        {project.name}
      </LpLink>
      <span className="chat-crumb-chevron" aria-hidden="true">▸</span>
    </>
  );
}

export interface SessionHeaderProps {
  project: Project;
  workstream: string;
  repo: string | null;
  box: Pick<Instance, 'name'> | null;
  working: boolean;
  /** Open in Lab: busy while it opens. */
  opening: boolean;
  onOpenFull: () => void;
  /** Archive, where this person may: the confirm dialog is SdkChatView's. */
  archive: null | { label: string; disabled: boolean; hint: string; onArchive: () => void };
  /** Resize box, on the owner's own EC2 box, its hint the current size: the dialog is BoxResizeLaunchPad, opened by SdkChatView. */
  resize?: null | { hint: string; onOpen: () => void };
}

export function SessionHeader({ project, workstream, repo, box, working, opening, onOpenFull, archive, resize }: SessionHeaderProps) {
  const desktopHref = desktopSessionHref({ projectId: project.id, workstream, shared: project.role === 'collaborator' });
  const { sidePanel, refresh } = useChatChrome();
  // The session's one title, the sidebar row's too.
  const wsRow = project.workstreams?.find(w => w.name === workstream);
  const title = workstreamTitle(project, workstream, wsRow);
  const branch = branchChip(project, workstream);
  // A review session: Reviews / the PR, on its own branch.
  const review = useReviewOf(project.id, workstream);
  const own = useOwnProject(project.id);
  // The space chip became a Project files chip under project-files-enabled: it opens Files.
  // Only where Files is the Files tool (SidePanel.tsx): under the chrome refresh, which the project crumb needs anyway.
  const projectFilesOn = useFlag(FLAGS.projectFiles, false) && refresh === true;
  const pr = useSessionPrRow(project.id, workstream, own != null && !review);
  return (
    <>
      {review ? (
        <div className="chat-title">
          <Link to="/chat/reviews" className="rv-crumb">Reviews</Link>
          <span className="chat-crumb-sep rv-sep" aria-hidden="true">/</span>
          <span className="chat-title-name" title={review.title}>
            {prShort(review.repo, review.number)}
            {/* A session marked before the pipeline names the PR has only its short label: say it once, as the PR page does. */}
            {review.title !== prShort(review.repo, review.number) && <span className="rv-crumb-title">{review.title}</span>}
          </span>
          {review.row?.headRefName && (
            <span className="chat-title-project" title="A checkout of the PR's own branch">
              <Icon name="arrow-merge" size="medium" aria-hidden="true" />{review.row.headRefName}
            </span>
          )}
          {working && (
            <span className="chat-title-state" data-status="working">
              <ProgressBar variant="spinner" size="small" isIndeterminate aria-label="Claude is reviewing" />
              <span aria-hidden="true">Working</span>
            </span>
          )}
        </div>
      ) : own ? (
        <div className="chat-title" data-crumb="project">
          <ProjectCrumb project={own} />
          <span className="chat-title-name" title={title}>{title}</span>
          {branch && (
            <span className="chat-title-project chat-title-branch" title="Branch">
              <Icon name="arrow-merge" size="medium" aria-hidden="true" />{branch}
            </span>
          )}
          {projectFilesOn && sidePanel?.show && (
            <Button variant="minimal" className="chat-title-project chat-title-files" data-tip="Open Project files in the side panel"
              onPress={() => { showProjectFiles(project.id, workstream); sidePanel.show?.('files'); }}>
              <Icon name="folders" size="medium" aria-hidden="true" />Project files
            </Button>
          )}
          {pr?.repo && pr.number != null && (
            <Button variant="minimal" className="chat-title-project chat-title-pr"
              aria-label={`Pull request ${prShort(pr.repo, pr.number)}${pr.title ? `: ${pr.title}` : ''}`}
              data-tip={sidePanel?.show ? 'Open its pull request tab' : pr.title}
              onPress={() => {
                if (sidePanel?.show) sidePanel.show('pr');
                else if (pr.url) window.open(pr.url, '_blank', 'noopener,noreferrer');
              }}>
              {prShort(pr.repo, pr.number)}
            </Button>
          )}
          {working && (
            <span className="chat-title-state" data-status="working">
              <ProgressBar variant="spinner" size="small" isIndeterminate aria-label="Claude is working" />
              <span aria-hidden="true">Working</span>
            </span>
          )}
        </div>
      ) : <div className="chat-title">
        {/* The chat's own space, fixed when it started (chat/chatSpaces.ts chatHomeSpace). */}
        <ChatSpaceChip place={{ instanceId: project.instanceId ?? null, spaceId: wsRow?.spaceId, spaceFixed: wsRow?.spaceFixedAt != null }} />
        <span className="chat-crumb-sep" aria-hidden="true">/</span>
        <span className="chat-title-name" title={title}>{title}</span>
        {title !== project.name && <span className="chat-title-project" title="Project"><Icon name="code" size="medium" aria-hidden="true" />{project.name}</span>}
        {repo && <span className="chat-title-repo" title={project.repoUrl ?? undefined}>{repo}</span>}
        {branch && (
          <span className="chat-title-project chat-title-branch" title="Branch">
            <Icon name="arrow-merge" size="medium" aria-hidden="true" />{branch}
          </span>
        )}
        {working && (
          <span className="chat-title-state" data-status="working">
            <ProgressBar variant="spinner" size="small" isIndeterminate aria-label="Claude is working" />
            <span aria-hidden="true">Working</span>
          </span>
        )}
      </div>}
      <div className="chat-header-actions">
        <ChatBoxTag project={project} box={box} />
        <MenuTrigger>
          <IconButton icon="more-horiz" variant="minimal" aria-label="Session actions" className="chat-session-more" />
          <Popover placement="bottom end" className={`${LP_THEME} chat-menu-popover`}>
            <Menu
              aria-label="Session actions"
              disabledKeys={[...(opening ? ['full'] : []), ...(archive?.disabled ? ['archive'] : [])]}
              onAction={key => {
                if (key === 'full') onOpenFull();
                else if (key === 'size') resize?.onOpen();
                else if (key === 'archive') archive?.onArchive();
              }}
            >
              <MenuItem id="full" textValue="Open in Lab">
                <Icon name="arrow-up-right" size="medium" aria-hidden="true" />
                <Text slot="label">{opening ? 'Opening…' : 'Open in Lab'}</Text>
                <Text slot="description">Continues this session in Lab</Text>
              </MenuItem>
              {desktopHref ? (
                <MenuItem id="desktop" textValue="Open in termag desktop" href={desktopHref}>
                  <Icon name="device-desktop" size="medium" aria-hidden="true" />
                  <Text slot="label">Open in termag desktop</Text>
                  <Text slot="description">A new thread in this project there, with its chats to import</Text>
                </MenuItem>
              ) : null}
              {resize ? (
                <MenuItem id="size" textValue="Resize box">
                  <Icon name="device-server" size="medium" aria-hidden="true" />
                  <Text slot="label">Resize box</Text>
                  <Text slot="description">{resize.hint}</Text>
                </MenuItem>
              ) : null}
              {archive ? (
                <MenuItem id="archive" textValue="Archive">
                  <Icon name="archive-outline" size="medium" aria-hidden="true" />
                  <Text slot="label">{archive.label}</Text>
                  <Text slot="description">{archive.hint}</Text>
                </MenuItem>
              ) : null}
            </Menu>
          </Popover>
        </MenuTrigger>
        {sidePanel && !sidePanel.open && <span className="chat-header-sep" aria-hidden="true" />}
        <SidePanelButton />
      </div>
    </>
  );
}
