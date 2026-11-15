// A project's menu in the sidebar's Projects view
// , under user-projects-enabled: its group head's ⋯ (also its right
// click) opens New session here, Rename project… and Archive project…, all LaunchPad.
// - Rename changes the project's name only (PATCH /api/user-projects/:id { name }); its
//   checkouts keep theirs. A taken name says so on the field; any other failure is an Alert,
//   and what was typed stays.
// - Change icon… picks the project's icon (ProjectIconPicker.tsx):
//   Automatic, the letters, an icon found in its repositories, or an upload.
// - Archive asks first, saying what it takes and what happens to each box, as the archive
//   will do it (GET …/archive-plan): "box-a stops: nothing else runs on it". A checkout that
//   won't archive leaves the project live, and the dialog says which and why.
// The project's archived sessions, and the project once it's archived, are in Archived
// (ArchivedRows.tsx), with Unarchive.
import React, { useEffect, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import {
  Alert, AlertText, Button, ButtonGroup, Dialog, Heading, IconButton, Input, Label, Menu, MenuItem, MenuTrigger, Modal,
  ModalOverlay, Popover, ProgressBar, Text, TextField,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { spacesApi, userProjectsApi, type SpaceView, type UserProjectArchivePlan, type UserProjectArchiveReport } from '../../services/api';
import { useProjects } from '../../contexts/ProjectContext';
import { announceChatsChanged, archiveBoxNotice, saveRunningBox } from '../../chat/archive';
import { boxFeed } from '../../services/boxFeed';
import { LP_THEME } from '../../launchpad/theme';
import { useSimpleDataIfAny, type OwnProject } from './simpleData';
import { ChangeIconDialog } from './ProjectIconPicker';
import { UseSpaceDialog } from './UseSpaceDialog';
import { SpaceSlackDialog } from './SpaceSlackDialog';
import { SpaceShareDialog } from './SpaceShareDialog';
import { useAuth } from '../../contexts/AuthContext';
import { FLAGS, useFlag } from '../../flags';

/** The project record's name limit (backend services/userProjects.ts USER_PROJECT_NAME_MAX). */
const NAME_MAX = 60;

/** New session with this project picked (NewChat reads ?project=). */
export const newSessionHereHref = (userProjectId: string) => `/chat/new?project=${encodeURIComponent(userProjectId)}`;

const sessions = (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`;

/** One box's line in the archive's confirm. */
export function boxFateLine(b: UserProjectArchivePlan['boxes'][number]): string {
  if (b.fate === 'stops') return `${b.boxName} stops: nothing else runs on it`;
  if (b.why === 'other-sessions') return `${b.boxName} keeps running: other sessions use it`;
  if (b.why === 'lab-session') return `${b.boxName} keeps running: a Lab session`;
  return `${b.boxName} stays as it is: ${b.detail ?? 'termag does not power it'}`;
}

/**
 * Lab's checkouts archive as Lab's own Archive does, and reopen there, not from
 * this sidebar's Archived (it lists chats): say so, by name.
 */
export function labLine(plan: Pick<UserProjectArchivePlan, 'checkouts'>): string | null {
  const lab = plan.checkouts.filter(c => c.kind === 'lab').map(c => c.name);
  if (lab.length === 0) return null;
  return `${lab.join(', ')} ${lab.length === 1 ? 'runs in Lab and reopens' : 'run in Lab and reopen'} from Lab's archive.`;
}

/**
 * A box the chat archive tried to stop and couldn't: each of the project's chat checkouts on it
 * keeps the running-box recovery a session's own archive saves (chat/archive.ts), so its
 * Archived row offers Box still running, and Stop from there. By box name, as the plan has them.
 */
export function saveStillRunning(plan: Pick<UserProjectArchivePlan, 'checkouts'> | null, report: UserProjectArchiveReport): string[] {
  const lines: string[] = [];
  for (const b of report.boxes) {
    if (!b.error) continue;
    const notice = archiveBoxNotice({ action: b.action, error: b.error });
    if (notice.leave) continue;
    lines.push(`${b.boxName} is still running: ${b.error}`);
    for (const c of plan?.checkouts ?? []) {
      if (c.kind !== 'chat' || c.boxName !== b.boxName || !report.archived.some(a => a.projectId === c.projectId)) continue;
      saveRunningBox({ projectId: c.projectId, projectName: c.name, instanceId: b.boxId, message: notice.message, retry: notice.retry, announced: false });
    }
  }
  return lines;
}

const checkoutsWere = (n: number) => `${n} ${n === 1 ? 'checkout was' : 'checkouts were'}`;

/** Why an archive stopped short, in a sentence per checkout left. */
export function archiveLeftLines(projectName: string, report: UserProjectArchiveReport): string[] {
  return [
    ...report.failed.map(f => `${f.name} didn't archive: ${f.error}`),
    `${projectName} stays live${report.archived.length ? `; ${checkoutsWere(report.archived.length)} archived` : ''}.`,
  ];
}

const responseOf = (err: unknown) => (err as { response?: { status?: number; data?: Record<string, unknown> } })?.response;
const errorText = (err: unknown, fallback: string) => {
  const e = responseOf(err)?.data?.error;
  return typeof e === 'string' && e ? e : fallback;
};

/** After a change: the page's projects and the project list again (a push follows, for the other tabs). */
function useAfterChange() {
  const data = useSimpleDataIfAny();
  const { reloadProjects } = useProjects();
  return async (archived: boolean) => {
    await Promise.all([
      data?.userProjects.reload(),
      archived ? reloadProjects().catch(() => { /* ProjectContext says so */ }) : undefined,
    ]);
    if (archived) {
      announceChatsChanged();
      void boxFeed.reload();
    }
  };
}

/** Which of a project's dialogs is open, and for which project: the list draws it, so it outlives the project's group (an archive takes the group away). */
export type ProjectDialog = { kind: 'rename' | 'icon' | 'archive' | 'files' | 'slack' | 'share'; project: OwnProject } | null;

/** The open dialog, drawn where it stays mounted (ProjectsList.tsx, outside the groups). */
export function ProjectDialogs({ dialog, onClose, onLeftSpace }: {
  dialog: ProjectDialog; onClose: () => void;
  /** Share…'s Leave: the list reads the spaces again and leaves what's on screen in it (ProjectsList.tsx leftSpace). */
  onLeftSpace?: (space: string) => void;
}) {
  if (!dialog) return null;
  if (dialog.kind === 'icon') return <ChangeIconDialog project={dialog.project} onClose={onClose} />;
  if (dialog.kind === 'share') return <ProjectShareDialog project={dialog.project} onClose={onClose} onLeft={onLeftSpace} />;
  if (dialog.kind === 'files' || dialog.kind === 'slack') return <ProjectFilesDialog kind={dialog.kind} project={dialog.project} onClose={onClose} />;
  return dialog.kind === 'rename'
    ? <RenameProjectDialog project={dialog.project} onClose={onClose} />
    : <ArchiveProjectDialog project={dialog.project} onClose={onClose} />;
}

/**
 * Under project-files-enabled: Use an existing space for files…
 * (PATCH /api/user-projects/:id { filesSpace }, the space it replaces kept in Other spaces), and Slack channels…, the
 * existing channel dialog for the project's files (behind space-channels-enabled too).
 */
function ProjectFilesDialog({ kind, project, onClose }: { kind: 'files' | 'slack'; project: OwnProject; onClose: () => void }) {
  const data = useSimpleDataIfAny();
  const filesSpace = data?.userProjects.list?.find(p => p.id === project.id)?.filesSpace?.name ?? null;
  if (kind === 'slack') return filesSpace ? <SpaceSlackDialog space={filesSpace} onClose={onClose} /> : null;
  return (
    <UseSpaceDialog
      title={`Use an existing space for ${project.name}'s files`}
      note="One you own that isn't another project's files or your My files: it becomes this project's Project files, with its files and its Slack channels. The one it replaces keeps its files, under Other spaces."
      current={filesSpace}
      onUse={async name => { await userProjectsApi.setFilesSpace(project.id, name); await data?.userProjects.reload(); }}
      onClose={onClose}
    />
  );
}

/** Share…'s hint, as a space head's Share space says what it shares (chat/spaceShare.ts). */
export const shareHint = (project: string) => `People and boxes with access to ${project}'s files`;

/**
 * Share… (under project-files-enabled): the space share dialog on the project's Project files, which is what a
 * project shares now that Group by Space and its heads' Share space are gone.
 * A project with no Project files yet gets them first, as the side panel's Files makes them on first use (FilesTool.tsx).
 */
export function ProjectShareDialog({ project, onClose, onLeft }: { project: OwnProject; onClose: () => void; onLeft?: (space: string) => void }) {
  const data = useSimpleDataIfAny();
  const { user } = useAuth();
  const listed = data?.userProjects.list?.find(p => p.id === project.id)?.filesSpace?.name ?? null;
  const [made, setMade] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [tries, setTries] = useState(0);
  const [fetched, setFetched] = useState<SpaceView | null>(null);
  const name = listed ?? made;
  // From the spaces ChatApp read, else read on its own (made a moment ago, after they were read).
  const space = name ? data?.spaces.spaces.find(x => x.name === name) ?? (fetched?.name === name ? fetched : undefined) : undefined;
  const reloadSpaces = () => data?.spaces.reload?.();
  useEffect(() => {
    if (listed) return undefined;
    let live = true;
    setError('');
    userProjectsApi.ensureFiles(project.id)
      .then(async v => {
        if (!live) return;
        if (!v.filesSpace) { setError(`Couldn't set up ${project.name}'s files`); return; }
        setMade(v.filesSpace.name);
        void data?.userProjects.reload();
      })
      .catch(err => { if (live) setError(errorText(err, `Couldn't set up ${project.name}'s files`)); });
    return () => { live = false; };
  }, [project.id, listed, tries]); // eslint-disable-line react-hooks/exhaustive-deps
  // Known but not among the spaces read: read that one, with its own error and Try again (the shared read keeps its
  // failures to itself), and the list again so the rest of the page has it too.
  const shown = Boolean(space);
  useEffect(() => {
    if (!name || shown) return undefined;
    let live = true;
    setError('');
    spacesApi.get(name)
      .then(r => { if (live) { setFetched(r.space); void reloadSpaces(); } })
      .catch(err => { if (live) setError(errorText(err, `Couldn't read ${project.name}'s files`)); });
    return () => { live = false; };
  }, [name, shown, tries]); // eslint-disable-line react-hooks/exhaustive-deps
  // Making them, or only reading the ones it has.
  const waiting = name ? `Opening ${project.name}'s files` : `Setting up ${project.name}'s files`;
  if (space) {
    return <SpaceShareDialog space={space} label={`${project.name}'s files`} userId={user?.id} onClose={onClose}
      onChanged={() => { void reloadSpaces(); }} onLeft={() => { onClose(); if (onLeft) onLeft(space.name); else void reloadSpaces(); }} />;
  }
  return (
    <ModalOverlay isOpen isDismissable onOpenChange={open => { if (!open) onClose(); }} className={LP_THEME}>
      <Modal size="small" className="chat-project-modal">
        <Dialog className="chat-project-dialog" aria-label={`Share ${project.name}'s files`}>
          <Heading slot="title" level={2} size="medium">Share {project.name}'s files</Heading>
          {error ? (
            <Alert status="error" hideIcon>
              <AlertText><p>{error}</p></AlertText>
            </Alert>
          ) : (
            <Text elementType="p" slot="subtitle" className="chat-project-dialog-note" role="status">
              <ProgressBar isIndeterminate size="small" variant="spinner" aria-label={waiting} />
              {' '}{waiting}…
            </Text>
          )}
          <ButtonGroup className="chat-project-dialog-buttons">
            <Button variant="minimal" onPress={onClose}>Close</Button>
            {error && <Button variant="primary" onPress={() => setTries(n => n + 1)}>Try again</Button>}
          </ButtonGroup>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export function ProjectMenu({ project, isOpen, onOpenChange, onDialog }: {
  project: OwnProject;
  /** Open from the head's right click as well as its ⋯ (ProjectsList.tsx). */
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rename or Archive chosen: the list opens the dialog (ProjectDialogs). */
  onDialog: (dialog: NonNullable<ProjectDialog>) => void;
}) {
  const navigate = useNavigate();
  const projectFiles = useFlag(FLAGS.projectFiles, false);
  const slackOn = useFlag(FLAGS.spaceChannels, false);
  const data = useSimpleDataIfAny();
  const hasFiles = Boolean(data?.userProjects.list?.find(p => p.id === project.id)?.filesSpace);
  return (
    <>
      <MenuTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
        <IconButton icon="more-horiz" variant="minimal" size="small" aria-label={`Options for ${project.name}`} className="chat-group-menu chat-project-menu" />
        <Popover placement="bottom end" className={`${LP_THEME} chat-menu-popover`}>
          <Menu aria-label={`${project.name}: actions`}
            onAction={key => {
              if (key === 'new') navigate(newSessionHereHref(project.id));
              else if (key === 'rename') onDialog({ kind: 'rename', project });
              else if (key === 'icon') onDialog({ kind: 'icon', project });
              else if (key === 'archive') onDialog({ kind: 'archive', project });
              else if (key === 'files') onDialog({ kind: 'files', project });
              else if (key === 'slack') onDialog({ kind: 'slack', project });
              else if (key === 'share') onDialog({ kind: 'share', project });
            }}>
            <MenuItem id="new" textValue="New session here">
              <Icon name="add" size="medium" aria-hidden="true" />
              <Text slot="label">New session here</Text>
            </MenuItem>
            <MenuItem id="rename" textValue="Rename project…">
              <Icon name="edit" size="medium" aria-hidden="true" />
              <Text slot="label">Rename project…</Text>
              <Text slot="description">Its sessions keep their names</Text>
            </MenuItem>
            <MenuItem id="icon" textValue="Change icon…">
              <Icon name="photo" size="medium" aria-hidden="true" />
              <Text slot="label">Change icon…</Text>
              <Text slot="description">A favicon, the letters, or an upload</Text>
            </MenuItem>
            {projectFiles && (
              <MenuItem id="files" textValue="Use an existing space for files…">
                <Icon name="folders" size="medium" aria-hidden="true" />
                <Text slot="label">Use an existing space for files…</Text>
                <Text slot="description">One that already has its files or Slack channels</Text>
              </MenuItem>
            )}
            {projectFiles && (
              <MenuItem id="share" textValue="Share…">
                <Icon name="share" size="medium" aria-hidden="true" />
                <Text slot="label">Share…</Text>
                <Text slot="description">{shareHint(project.name)}</Text>
              </MenuItem>
            )}
            {projectFiles && slackOn && hasFiles && (
              <MenuItem id="slack" textValue="Slack channels…">
                <Icon name="hash" size="medium" aria-hidden="true" />
                <Text slot="label">Slack channels…</Text>
                <Text slot="description">Linked to its Project files</Text>
              </MenuItem>
            )}
            <MenuItem id="archive" textValue="Archive project…">
              <Icon name="archive-outline" size="medium" aria-hidden="true" />
              <Text slot="label">Archive project…</Text>
              <Text slot="description">With its sessions. Asks first.</Text>
            </MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
    </>
  );
}

export function RenameProjectDialog({ project, onClose }: { project: OwnProject; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [taken, setTaken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const after = useAfterChange();
  const next = name.trim();
  const submit = async () => {
    if (!next || busy) return;
    if (next === project.name) { onClose(); return; }
    setBusy(true); setTaken(''); setError('');
    try {
      await userProjectsApi.update(project.id, { name: next });
      await after(false);
      onClose();
    } catch (err) {
      const res = responseOf(err);
      if (res?.data?.field === 'name') setTaken(errorText(err, 'Pick another name'));
      else setError(errorText(err, "Couldn't rename the project"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalOverlay isOpen isDismissable={!busy} onOpenChange={open => { if (!open) onClose(); }} className={LP_THEME}>
      <Modal size="small" className="chat-project-modal">
        <Dialog className="chat-project-dialog" aria-label={`Rename ${project.name}`}>
          <form onSubmit={e => { e.preventDefault(); void submit(); }}>
            <Heading slot="title" level={2} size="medium">Rename project</Heading>
            <Text elementType="p" slot="subtitle" className="chat-project-dialog-note">Its sessions, and their folders on the boxes, keep their names.</Text>
            {/* aria validation: a taken name says so without the browser blocking the next try. */}
            <TextField value={name} onChange={v => { setName(v); setTaken(''); }} isInvalid={taken !== ''} maxLength={NAME_MAX} validationBehavior="aria"
              autoFocus isDisabled={busy} className="chat-project-name-field">
              <Label>Name</Label>
              <Input spellCheck={false} />
              {taken && <Text slot="errorMessage" className="chat-project-field-error">{taken}</Text>}
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

type PlanRead = { kind: 'loading' } | { kind: 'ready'; plan: UserProjectArchivePlan } | { kind: 'failed'; error: string };

export function ArchiveProjectDialog({ project, onClose }: { project: OwnProject; onClose: () => void }) {
  const navigate = useNavigate();
  // The session on screen (its checkout): it goes with the archive, as a session's own archive leaves it.
  const openId = useMatch('/chat/p/:projectId')?.params.projectId ?? null;
  const leaveIfArchived = (report: UserProjectArchiveReport | undefined) => {
    if (openId && report?.archived.some(a => a.projectId === openId)) navigate('/chat');
  };
  const [read, setRead] = useState<PlanRead>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [left, setLeft] = useState<UserProjectArchiveReport | null>(null);
  // After an archive: boxes that didn't stop, and (a 503) the server's word that the project still needs marking.
  const [notes, setNotes] = useState<string[]>([]);
  const [again, setAgain] = useState(false);
  const after = useAfterChange();
  useEffect(() => {
    let live = true;
    userProjectsApi.archivePlan(project.id)
      .then(plan => { if (live) setRead({ kind: 'ready', plan }); })
      .catch(err => { if (live) setRead({ kind: 'failed', error: errorText(err, "Couldn't read what archiving would do") }); });
    return () => { live = false; };
  }, [project.id]);
  const plan = read.kind === 'ready' ? read.plan : null;
  const submit = async () => {
    // `again` stays as it is until the answer: a retry keeps its own buttons (disabled while busy).
    setBusy(true); setError('');
    try {
      const res = await userProjectsApi.update(project.id, { archived: true });
      await after(true);
      const stillRunning = res.archive ? saveStillRunning(plan, res.archive) : [];
      leaveIfArchived(res.archive);
      // A box that wouldn't stop is said here, as a session's own archive says it; the rest just closes.
      setAgain(false);
      if (stillRunning.length > 0 && res.archive) { setLeft(res.archive); setNotes(stillRunning); } else onClose();
    } catch (err) {
      const res = responseOf(err);
      const report = res?.data?.archive as UserProjectArchiveReport | undefined;
      const code = res?.data?.code;
      if (report && (code === 'user_project_archive_incomplete' || code === 'user_projects_unavailable')) {
        setLeft(report);
        const stillRunning = saveStillRunning(plan, report);
        // Busy (a 503): the checkouts are archived, the project isn't marked yet; the same archive finishes it.
        setNotes(code === 'user_projects_unavailable' ? [errorText(err, 'The project is busy; archive it again to finish'), ...stillRunning] : stillRunning);
        setAgain(code === 'user_projects_unavailable');
        await after(true);
        leaveIfArchived(report);
      } else setError(errorText(err, "Couldn't archive the project")); // a retry that fails this way can be tried again
    } finally {
      setBusy(false);
    }
  };
  const title = plan ? `Archive ${plan.name} and its ${sessions(plan.sessions)}?` : `Archive ${project.name}?`;
  return (
    <ModalOverlay isOpen isDismissable={!busy} onOpenChange={open => { if (!open) onClose(); }} className={LP_THEME}>
      <Modal size="small" className="chat-project-modal">
        <Dialog role="alertdialog" className="chat-project-dialog" aria-label={title}>
          <Heading slot="title" level={2} size="medium">{title}</Heading>
          {read.kind === 'loading' && <ProgressBar isIndeterminate size="small" variant="spinner" aria-label="Reading what archiving would do" />}
          {read.kind === 'failed' && (
            <Alert status="error" hideIcon><AlertText><p>{read.error}</p></AlertText></Alert>
          )}
          {plan && !left && (
            <>
              <Text elementType="p" slot="subtitle" className="chat-project-dialog-note">
                Its sessions move to Archived, where each reopens on its own. Unarchive brings the project back.
              </Text>
              {plan.boxes.length > 0 && (
                <ul className="chat-project-boxes" aria-label="What happens to each box">
                  {plan.boxes.map(b => <li key={b.boxId} data-fate={b.fate}>{boxFateLine(b)}</li>)}
                </ul>
              )}
              {labLine(plan) && <Text elementType="p" slot="description" className="chat-project-dialog-note">{labLine(plan)}</Text>}
            </>
          )}
          {left && (left.failed.length > 0 || notes.length > 0) && (
            <Alert status="warning" hideIcon>
              <AlertText>
                {(left.failed.length > 0 || again ? archiveLeftLines(project.name, left) : []).map(line => <p key={line}>{line}</p>)}
                {notes.map(line => <p key={line}>{line}</p>)}
              </AlertText>
            </Alert>
          )}
          {error && <Alert status="error" hideIcon><AlertText><p>{error}</p></AlertText></Alert>}
          <ButtonGroup className="chat-project-dialog-buttons">
            {left && again ? (
              <>
                <Button variant="minimal" onPress={onClose} isDisabled={busy}>Close</Button>
                <Button variant="destructive" autoFocus isDisabled={busy} onPress={() => { void submit(); }}>
                  {busy ? 'Archiving…' : 'Archive again'}
                </Button>
              </>
            ) : left ? (
              <Button variant="primary" autoFocus onPress={onClose}>Close</Button>
            ) : (
              <>
                <Button variant="minimal" onPress={onClose} isDisabled={busy}>Cancel</Button>
                <Button variant="destructive" autoFocus isDisabled={busy || !plan} onPress={() => { void submit(); }}>
                  {busy ? 'Archiving…' : 'Archive'}
                </Button>
              </>
            )}
          </ButtonGroup>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
