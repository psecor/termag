// A session's header under the chrome refresh,
// on a desktop width: the space and the session as a breadcrumb, the project as
// a chip when the session has a title, and a Working pill during a turn; then
// the box, a LaunchPad ⋯ menu (Open in Lab, Open in termag desktop, Resize box, Archive) and the panel toggle.
// The cost is not here: the composer's usage ring has it. The phone's one-row
// header is SdkChatView's own.
import React from 'react';
import { IconButton, Menu, MenuItem, MenuTrigger, Popover, ProgressBar, Text } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import type { Instance, Project } from '../../types';
import { FLAGS, useFlag } from '../../flags';
import { LP_THEME } from '../../launchpad/theme';
import { ChatBoxTag } from './ChatBoxTag';
import { SidePanelButton, useChatChrome } from './chatChrome';
import { ChatSpaceChip } from './SpaceSwatch';
import { Link } from 'react-router-dom';
import { prShort } from '../../chat/reviews';
import { useReviewOf } from './reviewsData';
import { desktopSessionHref } from '../../chat/desktopLinks';

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
  const { sidePanel } = useChatChrome();
  // Claude's own title for the session, where session titles are on, as in the sidebar.
  const titlesShown = useFlag(FLAGS.sessionTitles, false);
  const wsRow = project.workstreams?.find(w => w.name === workstream);
  const title = titlesShown ? wsRow?.sessionTitle?.trim() || null : null;
  // A review session: Reviews / the PR, on its own branch.
  const review = useReviewOf(project.id, workstream);
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
              <span aria-hidden="true">Reviewing</span>
            </span>
          )}
        </div>
      ) : <div className="chat-title">
        {/* The chat's own space, fixed when it started (chat/chatSpaces.ts chatHomeSpace). */}
        <ChatSpaceChip place={{ instanceId: project.instanceId ?? null, spaceId: wsRow?.spaceId, spaceFixed: wsRow?.spaceFixedAt != null }} />
        <span className="chat-crumb-sep" aria-hidden="true">/</span>
        <span className="chat-title-name" title={title ?? undefined}>{title ?? project.name}</span>
        {workstream !== 'main' && <span className="chat-title-ws">· {workstream}</span>}
        {title && <span className="chat-title-project" title="Project"><Icon name="code" size="medium" aria-hidden="true" />{project.name}</span>}
        {repo && <span className="chat-title-repo" title={project.repoUrl ?? undefined}>{repo}</span>}
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
