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
// and the session row's classes, so they read the same as those.
import React from 'react';
import {
  Button, ButtonGroup, Dialog, Heading, Menu, MenuItem, MenuTrigger, Modal, ModalOverlay, Popover, Text,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import type { ArchivedChat } from '../../services/api';
import { LP_THEME } from '../../launchpad/theme';
import {
  archiveSettling, archivedBoxLabel, archivedBoxWord, canReopen, offerRunningBox, permanentDeleteDetail, reopenTitle,
} from '../../chat/archive';
import { repoSlug } from '../../chat/simpleChat';
import { useSidebarView } from '../../chat/sidebarView';
import { fmtAge } from '../../utils/format';
import { StandardRowBody } from './StandardRow';
import { StatusMark } from './StatusMark';

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
}

export function ArchivedSection(props: ArchivedSectionProps) {
  const { chats, open, onOpenChange, notice, error } = props;
  const view = useSidebarView();
  const now = Date.now();
  const count = `${chats.length} ${chats.length === 1 ? 'session' : 'sessions'}`;
  return (
    <section className="chat-group chat-archived-group" data-folded={open ? undefined : true} aria-label="Archived">
      <div className="chat-group-head">
        <Button variant="minimal" className="chat-group-toggle chat-archived-fold" aria-expanded={open} aria-controls={open ? LIST_ID : undefined}
          data-tip={open ? 'Fold Archived' : 'Show the archived sessions'}
          onPress={() => onOpenChange(!open)}
          onKeyDown={e => {
            if ((e.key === 'ArrowLeft' && open) || (e.key === 'ArrowRight' && !open)) { e.preventDefault(); onOpenChange(!open); }
          }}>
          <span className="chat-group-caret" aria-hidden="true" />
          <span className="chat-group-name">Archived</span>
          <span className="chat-group-count" aria-hidden="true">{chats.length}</span>
          <span className="chat-sr">, {count}</span>
        </Button>
      </div>
      {open && (
        <ul className="chat-group-list chat-archived-rows" id={LIST_ID} aria-label="Archived">
          {chats.map(c => (
            <ArchivedRow key={c.id} chat={c} standard={view.density === 'standard'} now={now} {...props} />
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
            <StandardRowBody name={chat.name} age={age} where={repo} state={{ kind: 'off', text: sentence(box), message: null }} />
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
