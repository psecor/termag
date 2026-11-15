// "Use an existing space" (part B), all LaunchPad: Settings → My
// files' "Use an existing space as My files…" and a project's menu's "Use an existing space for files…". It lists
// the spaces the person owns (GET /api/spaces), but the one in that role now, in a Select; Use saves it through
// `onUse`, whose refusal (409 space_in_use, 403 space_not_owned, 404 space_not_found) is said on the dialog and
// leaves it open. The space it replaces is kept, in Other spaces.
import React, { useEffect, useState } from 'react';
import {
  Alert, AlertText, Button, ButtonGroup, Dialog, Heading, Label, ListBox, ListBoxItem, Modal, ModalOverlay, Popover, Select, SelectValue, Text,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { spacesApi, userProjectsApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { usableSpaces, useSpaceErrorText } from '../../chat/filesTool';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';

export function UseSpaceDialog({ title, note, current, onUse, onClose }: {
  title: string;
  /** What changes, under the title. */
  note: string;
  /** The space in that role now, left out. */
  current: string | null;
  /** Saves the pick; rejects with the route's error to keep the dialog open. */
  onUse: (space: string) => Promise<void>;
  onClose: () => void;
}) {
  const [names, setNames] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Its icons (the Select's chevron, the Alert's) need LaunchPad's sprite, which Settings doesn't load on its own.
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  const { user } = useAuth();
  const myFiles = user?.myFilesSpace ?? null;
  useEffect(() => {
    let live = true;
    // Leave out what's already in a role: the projects' files (a failed read leaves that to the server) and My files.
    const taken = userProjectsApi.list().then(list => list.flatMap(p => (p.filesSpace ? [p.filesSpace.name] : [])), () => [] as string[]);
    Promise.all([spacesApi.list(), taken])
      .then(([r, inUse]) => {
        if (live) setNames(usableSpaces(r.spaces.map(s => ({ name: s.name, role: s.role ?? '' })), current, [...inUse, ...(myFiles ? [myFiles] : [])]));
      })
      .catch(() => { if (live) setLoadError(true); });
    return () => { live = false; };
  }, [current, myFiles]);
  const use = async () => {
    if (!picked || busy) return;
    setBusy(true); setError('');
    try {
      await onUse(picked);
      onClose();
    } catch (err) {
      setError(useSpaceErrorText((err as { response?: { data?: { code?: string; error?: string } } })?.response?.data));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalOverlay isOpen isDismissable={!busy} onOpenChange={open => { if (!open) onClose(); }} className={LP_THEME}>
      <Modal size="small" className="chat-project-modal">
        <Dialog className="chat-project-dialog use-space-dialog" aria-label={title}>
          <Heading slot="title" level={2} size="medium">{title}</Heading>
          <Text elementType="p" slot="subtitle" className="chat-project-dialog-note">{note}</Text>
          {loadError ? (
            <Alert status="error"><AlertText>Couldn't list your spaces. Close this and try again.</AlertText></Alert>
          ) : names && names.length === 0 ? (
            <Text elementType="p" className="chat-project-dialog-note">You don't own another space to use.</Text>
          ) : (
            <Select className={`${LP_THEME} box-size-select use-space-select`} selectedKey={picked} placeholder={names ? 'Pick one' : 'Loading…'}
              onSelectionChange={key => { setPicked(key == null ? null : String(key)); setError(''); }} isDisabled={busy || !names}>
              <Label className="box-size-select-label">Space</Label>
              <Button className="box-size-select-button">
                <SelectValue />
                <Icon name="chevron-down" size="small" />
              </Button>
              <Popover className={`${LP_THEME} box-size-select-popover`} placement="bottom start">
                <ListBox items={(names ?? []).map(n => ({ id: n }))}>
                  {item => <ListBoxItem id={item.id} textValue={item.id}><span className="use-space-name">{item.id}</span></ListBoxItem>}
                </ListBox>
              </Popover>
            </Select>
          )}
          {error && <Alert status="error"><AlertText>{error}</AlertText></Alert>}
          <ButtonGroup className="chat-archived-confirm-buttons">
            <Button variant="minimal" onPress={onClose} isDisabled={busy}>Cancel</Button>
            <Button variant="primary" onPress={() => { void use(); }} isDisabled={!picked || busy}>{busy ? 'Saving…' : 'Use it'}</Button>
          </ButtonGroup>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
