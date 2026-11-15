// A session card's Rename…: a person's own
// title for the session (POST /api/chats/:id/title), which sticks against
// Claude's later titles. LaunchPad's dialog and text field, as the project's
// Rename is (ProjectMenu.tsx).
import React, { useState } from 'react';
import {
  Alert, AlertText, Button, ButtonGroup, Dialog, Heading, Input, Label, Modal, ModalOverlay, Text, TextField,
} from '@launchpad-ui/components';
import { chatsApi } from '../../services/api';
import { LP_THEME } from '../../launchpad/theme';

/** As long as a session title may be (backend services/chatRunner.ts SESSION_TITLE_MAX cuts every title to it). */
const TITLE_MAX = 80;

export function RenameSessionDialog({ session, onRenamed, onClose }: {
  /** `locked`: its title is already a person's (sessionTitleSource 'person'), which Claude's titles don't replace. */
  session: { projectId: string; workstream: string; title: string; locked: boolean };
  /** After the rename lands: the list reads it again. */
  onRenamed: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(session.title);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const next = title.trim();
  const submit = async () => {
    if (!next || busy) return;
    // Kept as it is, a title that's Claude's still becomes the person's, so Claude's next title doesn't replace it.
    if (next === session.title && session.locked) { onClose(); return; }
    setBusy(true); setError('');
    try {
      await chatsApi.rename(session.projectId, session.workstream, next);
      await onRenamed();
      onClose();
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Couldn't rename the session");
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalOverlay isOpen isDismissable={!busy} onOpenChange={open => { if (!open) onClose(); }} className={LP_THEME}>
      <Modal size="small" className="chat-project-modal">
        <Dialog className="chat-project-dialog" aria-label={`Rename ${session.title}`}>
          <form onSubmit={e => { e.preventDefault(); void submit(); }}>
            <Heading slot="title" level={2} size="medium">Rename session</Heading>
            <Text elementType="p" slot="subtitle" className="chat-project-dialog-note">Your name for it stays, whatever titles Claude gives it later.</Text>
            <TextField value={title} onChange={setTitle} maxLength={TITLE_MAX} autoFocus isDisabled={busy} className="chat-project-name-field">
              <Label>Title</Label>
              <Input spellCheck={false} />
            </TextField>
            {error && (
              <Alert status="error" hideIcon>
                <AlertText><p>{error}</p></AlertText>
              </Alert>
            )}
            <ButtonGroup className="chat-project-dialog-buttons">
              <Button variant="minimal" onPress={onClose} isDisabled={busy}>Cancel</Button>
              <Button variant="primary" type="submit" isDisabled={busy || !next}>{busy ? 'Renaming…' : 'Rename'}</Button>
            </ButtonGroup>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
