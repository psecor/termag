// The sidebar's Archived section under the chrome refresh.
// ArchivedChats.tsx keeps the
// list, Reopen and Delete; this draws them the way the refresh draws a space:
// - a head like a space's (the caret, the name and the count) that folds the
//   list, with the section's border under it, above the account;
// - each chat a row like a session's: one line in Compact (the name, then the
//   box's state in a word), or the name and how long ago it was archived,
//   then its repository and box, in Standard (the view options' Rows);
// - Reopen, "Box still running" and Delete forever… in a LaunchPad menu that
//   the row opens, with ⋯ in place of the box's word on hover, and Delete's
//   confirm in LaunchPad's alert dialog.
// The head's toggle and the row are LaunchPad Buttons with the space head's
// and the session row's classes, so they read the same as those. Under
// user-projects-enabled the
// person's archived projects come first, each with Unarchive; their sessions
// stay archived below and reopen one by one.
// In the sidebar redesign (`cards`) each row is a
// session card instead: the project's icon with the model's mark, the session's
// title, and a hollow ring with how long ago it was archived; Reopen (or
// Unarchive) and ⋯ float over its right end on hover, and a press on the card
// opens the same menu as before. The person's archived sessions (archived from a
// card or a space's Files, ProjectsList.tsx) are listed with them (`sessions`).
import React from 'react';
import {
  Button, ButtonGroup, Dialog, Heading, IconButton, Menu, MenuItem, MenuTrigger, Modal, ModalOverlay, Popover, Text,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import type { ArchivedChat } from '../../services/api';
import { LP_THEME } from '../../launchpad/theme';
import {
  archiveSettling, archivedBoxLabel, archivedBoxWord, canReopen, offerRunningBox, permanentDeleteDetail, reopenTitle,
} from '../../chat/archive';
import { repoSlug } from '../../chat/simpleChat';
import { useSidebarView } from '../../chat/sidebarView';
import { modelMarkFor } from '../../chat/modelMark';
import { archivedCardTip, shortAge } from '../../chat/sessionCard';
import { sessionTitle } from '../../chat/sessionTitle';
import type { Project } from '../../types';
import { fmtAge } from '../../utils/format';
import { StandardRowBody } from './StandardRow';
import { StatusMark } from './StatusMark';
import { CardLines } from './SessionCard';
import { ProjectGlyph } from './ProjectGlyph';
import { ModelMark } from './ModelMark';

const LIST_ID = 'chat-archived-rows';

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface ArchivedSectionProps {
  chats: readonly ArchivedChat[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The chat on screen, which reads as the selected row. */
  activeId: string | null;
  /** The chat a call is running for; every action waits while one is. */
  busy: string | null;
  /** The chat whose reopen waits for its box's agent. */
  pendingId: string | null;
  /** Chats this tab archived while their box stayed up (chat/archive.ts recoveries). */
  recoveries: Readonly<Record<string, unknown>>;
  notice: string;
  error: string;
  onReopen: (chat: ArchivedChat) => void;
  onBoxRunning: (chat: ArchivedChat) => void;
  onDelete: (chat: ArchivedChat) => void;
  /** The person's archived projects (user-projects-enabled), first, each with Unarchive. */
  projects?: ReadonlyArray<{ id: string; name: string; repos?: readonly string[] }>;
  /** The project an Unarchive is running for. */
  unarchiving?: string | null;
  onUnarchive?: (project: { id: string; name: string }) => void;
  /** The sidebar redesign's Archived (ProjectsList's bottom row opens it, with its own head): the list alone, always open. */
  bare?: boolean;
  /** The redesign's cards in place of the rows (with `bare`). */
  cards?: boolean;
  /** The person's archived sessions, as ProjectsList draws their cards, after the projects. */
  sessions?: React.ReactNode;
}

export function ArchivedSection(props: ArchivedSectionProps) {
  const { chats, onOpenChange, notice, error, projects = [], unarchiving = null, onUnarchive, bare = false, cards = false, sessions = null } = props;
  const open = bare || props.open;
  const view = useSidebarView();
  const now = Date.now();
  const count = [
    ...(projects.length ? [`${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`] : []),
    `${chats.length} ${chats.length === 1 ? 'session' : 'sessions'}`,
  ].join(', ');
  return (
    <section className="chat-group chat-archived-group" data-folded={open ? undefined : true} aria-label="Archived" data-bare={bare || undefined}>
      {!bare && <div className="chat-group-head">
        <Button variant="minimal" className="chat-group-toggle chat-archived-fold" aria-expanded={open} aria-controls={open ? LIST_ID : undefined}
          data-tip={open ? 'Fold Archived' : 'Show the archived sessions'}
          onPress={() => onOpenChange(!open)}
          onKeyDown={e => {
            if ((e.key === 'ArrowLeft' && open) || (e.key === 'ArrowRight' && !open)) { e.preventDefault(); onOpenChange(!open); }
          }}>
          <span className="chat-group-caret" aria-hidden="true" />
          <span className="chat-group-name">Archived</span>
          <span className="chat-group-count" aria-hidden="true">{chats.length + projects.length}</span>
          <span className="chat-sr">, {count}</span>
        </Button>
      </div>}
      {open && (
        <ul className="chat-group-list chat-archived-rows" id={LIST_ID} aria-label="Archived">
          {onUnarchive && projects.map(p => (cards
            ? <ArchivedProjectCard key={`project:${p.id}`} project={p} busy={unarchiving === p.id} disabled={unarchiving !== null}
              onUnarchive={onUnarchive} />
            : <ArchivedProjectRow key={`project:${p.id}`} project={p} busy={unarchiving === p.id} disabled={unarchiving !== null}
              standard={view.density === 'standard'} onUnarchive={onUnarchive} />
          ))}
          {sessions}
          {chats.map(c => (cards
            ? <ArchivedChatCard key={c.id} chat={c} standard={view.density === 'standard'} now={now} {...props} />
            : <ArchivedRow key={c.id} chat={c} standard={view.density === 'standard'} now={now} {...props} />
          ))}
        </ul>
      )}
      {open && notice && <p className="chat-archived-note" role="status">{notice}</p>}
      {open && error && <p className="chat-archived-note" data-tone="error" role="alert">{error}</p>}
    </section>
  );
}

function ArchivedRow({ chat, standard, now, activeId, busy, pendingId, recoveries, onReopen, onBoxRunning, onDelete }: ArchivedSectionProps & {
  chat: ArchivedChat;
  standard: boolean;
  now: number;
}) {
  const status = chat.box?.status;
  const box = archivedBoxLabel(status);
  const repo = repoSlug(chat.repoUrl);
  const age = fmtAge(now - new Date(chat.archivedAt).getTime());
  const reopening = busy === chat.id || pendingId === chat.id;
  // A box on its way down or up, or this row's reopen, turns the spinner the session rows use for work.
  const working = reopening || archiveSettling([status]);
  const running = offerRunningBox(Boolean(recoveries[chat.id]), status);
  const disabledKeys = [
    ...(busy !== null || pendingId !== null || !canReopen(status, chat.storedHistory) ? ['reopen'] : []),
    ...(busy !== null ? ['running', 'delete'] : []),
  ];
  const tip = [chat.name, repo, sentence(box), `Archived ${age} ago`].filter(Boolean).join('\n');
  return (
    <li className="chat-item-li chat-archived-li">
      <MenuTrigger>
        <Button variant="minimal" className={`chat-item chat-archived-item${chat.id === activeId ? ' active' : ''}`}
          aria-label={`${chat.name}, ${box}`} aria-current={chat.id === activeId ? 'page' : undefined}
          data-state="off" data-density={standard ? 'standard' : undefined} data-tip={tip}>
          <StatusMark kind={working ? 'working' : 'off'} />
          {standard ? (
            <StandardRowBody name={chat.name} age={age} where={repo} state={{ kind: 'off', text: sentence(box), message: null, unseen: false }} />
          ) : (
            <>
              <span className="chat-item-name">{chat.name}</span>
              <span className="chat-item-age" aria-hidden="true">{archivedBoxWord(status)}</span>
            </>
          )}
          <span className="chat-archived-more" aria-hidden="true"><Icon name="more-horiz" size="medium" /></span>
        </Button>
        <Popover placement="bottom start" className={`${LP_THEME} chat-menu-popover`}>
          <Menu aria-label={`Actions for ${chat.name}`} disabledKeys={disabledKeys}
            onAction={key => {
              if (key === 'reopen') onReopen(chat);
              else if (key === 'running') onBoxRunning(chat);
              else if (key === 'delete') onDelete(chat);
            }}>
            <MenuItem id="reopen" textValue="Reopen">
              <Icon name="restore" size="medium" aria-hidden="true" />
              <Text slot="label">{reopening ? 'Reopening…' : 'Reopen'}</Text>
              <Text slot="description">{reopenTitle(status, chat.storedHistory)}</Text>
            </MenuItem>
            {running ? (
              <MenuItem id="running" textValue="Box still running">
                <Icon name="device-server" size="medium" aria-hidden="true" />
                <Text slot="label">Box still running</Text>
                <Text slot="description">Open it to stop or hibernate the box</Text>
              </MenuItem>
            ) : null}
            <MenuItem id="delete" textValue="Delete forever" className="chat-menu-danger">
              <Icon name="delete" size="medium" aria-hidden="true" />
              <Text slot="label">Delete forever…</Text>
              <Text slot="description">The session and its history, for good. Asks first.</Text>
            </MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
    </li>
  );
}

/** An archived project (user-projects-enabled): a row like a session's, "Project" where a session says its box, its menu Unarchive. */
function ArchivedProjectRow({ project, busy, disabled, standard, onUnarchive }: {
  project: { id: string; name: string };
  busy: boolean;
  disabled: boolean;
  standard: boolean;
  onUnarchive: (project: { id: string; name: string }) => void;
}) {
  return (
    <li className="chat-item-li chat-archived-li" data-archived="project">
      <MenuTrigger>
        <Button variant="minimal" className="chat-item chat-archived-item" aria-label={`${project.name}, an archived project`}
          data-state="off" data-density={standard ? 'standard' : undefined} data-tip={`${project.name}\nArchived project`}>
          <StatusMark kind={busy ? 'working' : 'off'} />
          {standard ? (
            <StandardRowBody name={project.name} age={null} where={null} state={{ kind: 'off', text: 'Archived project', message: null, unseen: false }} />
          ) : (
            <>
              <span className="chat-item-name">{project.name}</span>
              <span className="chat-item-age" aria-hidden="true">Project</span>
            </>
          )}
          <span className="chat-archived-more" aria-hidden="true"><Icon name="more-horiz" size="medium" /></span>
        </Button>
        <Popover placement="bottom start" className={`${LP_THEME} chat-menu-popover`}>
          <Menu aria-label={`Actions for ${project.name}`} disabledKeys={disabled ? ['unarchive'] : []}
            onAction={key => { if (key === 'unarchive') onUnarchive(project); }}>
            <MenuItem id="unarchive" textValue="Unarchive">
              <Icon name="restore" size="medium" aria-hidden="true" />
              <Text slot="label">{busy ? 'Unarchiving…' : 'Unarchive'}</Text>
              <Text slot="description">Brings the project back; its sessions reopen one by one from here</Text>
            </MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
    </li>
  );
}

/** Delete forever's confirm under the refresh: LaunchPad's alert dialog, with the same words as ConfirmDialog's. */
export function ArchivedDeleteConfirm({ chat, onConfirm, onCancel }: {
  chat: ArchivedChat;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ModalOverlay isOpen isDismissable onOpenChange={o => { if (!o) onCancel(); }} className={LP_THEME}>
      <Modal size="small" className="chat-archived-confirm">
        <Dialog role="alertdialog" className="chat-archived-confirm-dialog">
          <Heading slot="title" level={2} size="medium">Delete {chat.name} permanently?</Heading>
          <Text elementType="p" slot="subtitle">{permanentDeleteDetail(chat.box, chat.otherProjects)}</Text>
          <ButtonGroup className="chat-archived-confirm-buttons">
            <Button variant="minimal" onPress={onCancel}>Cancel</Button>
            <Button variant="destructive" autoFocus onPress={onConfirm}>Delete permanently</Button>
          </ButtonGroup>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** The ⋯ that hangs a LaunchPad menu off an archived card, drawn as the session card's own ⋯ (ContextMenu.tsx MenuButton). */
function CardMenuButton({ label }: { label: string }) {
  return (
    <Button variant="minimal" className="item-menu-btn" aria-label={`Options for ${label}`} data-tip="Options">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <circle cx="8" cy="3.5" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="12.5" r="1.4" fill="currentColor" />
      </svg>
    </Button>
  );
}

/** An archived chat as the redesign's card: pressing it opens its menu (it has no conversation to open until it's reopened). */
function ArchivedChatCard({ chat, standard, now, activeId, busy, pendingId, recoveries, onReopen, onBoxRunning, onDelete }: ArchivedSectionProps & {
  chat: ArchivedChat;
  standard: boolean;
  now: number;
}) {
  const status = chat.box?.status;
  const box = archivedBoxLabel(status);
  const repo = repoSlug(chat.repoUrl);
  const title = sessionTitle({ projectName: chat.name, workstream: 'main', sessionTitle: chat.sessionTitle, sessionTitleSource: chat.sessionTitleSource });
  const at = Date.parse(chat.archivedAt);
  const age = Number.isNaN(at) ? null : shortAge(Math.max(0, now - at));
  const reopening = busy === chat.id || pendingId === chat.id;
  // A box on its way down or up, or this card's reopen, turns the spinner the cards use for work.
  const working = reopening || archiveSettling([status]);
  const running = offerRunningBox(Boolean(recoveries[chat.id]), status);
  const reopenOff = busy !== null || pendingId !== null || !canReopen(status, chat.storedHistory);
  const disabledKeys = [...(reopenOff ? ['reopen'] : []), ...(busy !== null ? ['running', 'delete'] : [])];
  const agent = chat.agent;
  const mark = modelMarkFor(
    { workflows: [{ type: 'agent', provider: agent?.provider ?? 'claude-chat', backend: agent?.backend ?? null, model: agent?.model ?? null, workstreamId: null }] } as unknown as Pick<Project, 'workflows'>,
    null, agent?.provider ?? 'claude-chat',
  );
  const state = { kind: working ? 'working' as const : 'off' as const, text: sentence(box), message: null, unseen: false };
  const menu = (
    <Popover placement="bottom end" className={`${LP_THEME} chat-menu-popover`}>
      <Menu aria-label={`Actions for ${title}`} disabledKeys={disabledKeys}
        onAction={key => {
          if (key === 'reopen') onReopen(chat);
          else if (key === 'running') onBoxRunning(chat);
          else if (key === 'delete') onDelete(chat);
        }}>
        <MenuItem id="reopen" textValue="Reopen">
          <Icon name="restore" size="medium" aria-hidden="true" />
          <Text slot="label">{reopening ? 'Reopening…' : 'Reopen'}</Text>
          <Text slot="description">{reopenTitle(status, chat.storedHistory)}</Text>
        </MenuItem>
        {running ? (
          <MenuItem id="running" textValue="Box still running">
            <Icon name="device-server" size="medium" aria-hidden="true" />
            <Text slot="label">Box still running</Text>
            <Text slot="description">Open it to stop or hibernate the box</Text>
          </MenuItem>
        ) : null}
        <MenuItem id="delete" textValue="Delete forever" className="chat-menu-danger">
          <Icon name="delete" size="medium" aria-hidden="true" />
          <Text slot="label">Delete forever…</Text>
          <Text slot="description">The session and its history, for good. Asks first.</Text>
        </MenuItem>
      </Menu>
    </Popover>
  );
  return (
    <li className="sc-li chat-archived-li" data-archived="chat">
      <div className="sc-wrap">
        <MenuTrigger>
          <Button variant="minimal" className="sc sc-button" aria-label={`${title}, archived, ${box}`}
            aria-current={chat.id === activeId ? 'page' : undefined} data-state="off" data-density={standard ? 'standard' : 'compact'}
            data-tip={archivedCardTip({ title, project: chat.name, repo, age, box: sentence(box) })}>
            <CardLines title={title} state={state} age={age} standard={standard} branch={null} pr={null}
              box={chat.box?.name ?? null} boxTip={chat.box ? `${chat.box.name}\n${sentence(box)}` : null} sr={`archived, ${box}`}
              glyph={<ProjectGlyph repos={repo ? [repo] : []} size={15} badge={<ModelMark {...mark} />} />} />
          </Button>
          {menu}
        </MenuTrigger>
        <span className="sc-over">
          <IconButton icon="restore" variant="minimal" size="small" aria-label={`Reopen ${title}`} isDisabled={reopenOff}
            data-tip={reopening ? 'Reopening…' : reopenTitle(status, chat.storedHistory)} onPress={() => onReopen(chat)} />
          <MenuTrigger>
            <CardMenuButton label={title} />
            {menu}
          </MenuTrigger>
        </span>
      </div>
    </li>
  );
}

/** An archived project as the redesign's card: its icon and name, a hollow ring, and Unarchive. */
function ArchivedProjectCard({ project, busy, disabled, onUnarchive }: {
  project: { id: string; name: string; repos?: readonly string[] };
  busy: boolean;
  disabled: boolean;
  onUnarchive: (project: { id: string; name: string }) => void;
}) {
  const state = { kind: busy ? 'working' as const : 'off' as const, text: 'Archived project', message: null, unseen: false };
  const menu = (
    <Popover placement="bottom end" className={`${LP_THEME} chat-menu-popover`}>
      <Menu aria-label={`Actions for ${project.name}`} disabledKeys={disabled ? ['unarchive'] : []}
        onAction={key => { if (key === 'unarchive') onUnarchive(project); }}>
        <MenuItem id="unarchive" textValue="Unarchive">
          <Icon name="restore" size="medium" aria-hidden="true" />
          <Text slot="label">{busy ? 'Unarchiving…' : 'Unarchive'}</Text>
          <Text slot="description">Brings the project back; its sessions reopen one by one from here</Text>
        </MenuItem>
      </Menu>
    </Popover>
  );
  return (
    <li className="sc-li chat-archived-li" data-archived="project">
      <div className="sc-wrap">
        <MenuTrigger>
          <Button variant="minimal" className="sc sc-button" aria-label={`${project.name}, an archived project`}
            data-state="off" data-density="compact" data-tip={`${project.name}\nArchived project`}>
            <CardLines title={project.name} state={state} age={null} standard={false} branch={null} pr={null} box={null} boxTip={null}
              sr="an archived project" glyph={<ProjectGlyph repos={project.repos ?? []} size={15} />} />
          </Button>
          {menu}
        </MenuTrigger>
        <span className="sc-over">
          <IconButton icon="restore" variant="minimal" size="small" aria-label={`Unarchive ${project.name}`} isDisabled={disabled}
            data-tip="Unarchive: its sessions reopen one by one from here" onPress={() => onUnarchive(project)} />
          <MenuTrigger>
            <CardMenuButton label={project.name} />
            {menu}
          </MenuTrigger>
        </span>
      </div>
    </li>
  );
}
