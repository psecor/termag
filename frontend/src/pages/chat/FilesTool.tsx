// The side panel's Files under the sidebar redesign (user-projects-enabled):
// files belong in
// the right side panel, not the left sidebar. The sidebar's Files group (this
// browser's file tabs and new tabs, chat/openItems.ts) is the tool's Open list,
// above what it explores (the explorer, FileExplorer.tsx, or the agents in no
// space). Picking one goes to it, as the sidebar's row did, with the panel kept
// open on Files where it lands (onPicked); its × closes the tab the way the
// sidebar's close did (TabClose.tsx). The list folds, kept per browser.
// Under project-files-enabled
// (part B) it explores Project files | My files: beside a session of one of the
// person's projects, that project's files (made now if it has none yet: "Project
// files are being set up"), or their My files (made the first time it's
// picked), with a LaunchPad ToggleButtonGroup in the explorer's head; then the
// other spaces they reach under a folded Other spaces. Beside a file in one of
// them the same, opened on its own. Anywhere else (an automation's run, a
// session shared with you) Files is as before. It never says "space".
import React, { useEffect, useReducer, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, ButtonGroup, Dialog, EmptyState, Heading, IconButton, Modal, ModalOverlay, Text, ToggleButton, ToggleButtonGroup, Tooltip, TooltipTrigger } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { useAuth } from '../../contexts/AuthContext';
import { FLAGS, useFlag } from '../../flags';
import { authApi, spacesApi, userProjectsApi } from '../../services/api';
import type { Project } from '../../types';
import { itemHref, panelFileItems } from '../../chat/openItems';
import {
  filesProjectOf, filesToolOpenItems, FILES_TOOL_OTHER_OPEN_KEY, initialFilesChoice, openItemName, openItemTip, openItemWhere, otherSpaces,
  moveFailureText, moveHalfDoneText, readOpenFolded, readStoredYes, writeOpenFolded, writeStoredYes,
  type FileTab, type FilesChoice, type FilesPlace, type FilesProject,
} from '../../chat/filesTool';
import { fileName } from '../../chat/fileExplorer';
import { ExplorerPanel, forgetListingsWhenNextShown } from './FileExplorer';
import { FileIcon, FolderIcon, plainClick } from './OpenItems';
import { useCloseTabs, useTabGroups } from './TabClose';
import { useSimpleData } from './simpleData';
import { usePanelFiles } from './panelFiles';

const storage = () => (typeof localStorage === 'undefined' ? null : localStorage);

/** This browser's open file tabs and new tabs, for the chat's home, which has no side panel. */
export function OpenFilesHome() {
  const { items, activeTab } = useSimpleData();
  const open = filesToolOpenItems(items.state.items);
  if (!open.length) return null;
  return <div className={`ft ft-home ${LP_THEME}`}><OpenList open={open} activeTab={activeTab} /></div>;
}

/** What Files explores and highlights (SidePanel.tsx's target). */
export interface FilesToolTarget { space: string; activePath?: string; activeDir?: string; activeAgent?: { projectId: string; workstream: string } }

interface Props {
  /** What Files explores today (the explorer or the agents in no space); shown where there's no Project files. */
  children?: React.ReactNode;
  onPicked?: () => void;
  /** The open session's checkout, beside a session. */
  project?: Project;
  workstream?: string;
  target?: FilesToolTarget | null;
  reveal?: { dir: string; n: number } | null;
}

/** The tool: the Open list over what Files explores. */
export function FilesTool({ children, onPicked, project, workstream = 'main', target, reveal }: Props) {
  const { items, activeTab } = useSimpleData();
  // Files open in the panel (panelFiles.ts): its Open list is this place's file tabs, then the main panel's.
  const open = [...panelFileItems(items.state, usePanelFiles()?.place), ...filesToolOpenItems(items.state.items)];
  const projectFilesOn = useFlag(FLAGS.projectFiles, false);
  return (
    <div className={`ft ${LP_THEME}`}>
      {open.length > 0 && <OpenList open={open} activeTab={activeTab} onPicked={onPicked} />}
      {projectFilesOn
        ? <ProjectFilesOr project={project} workstream={workstream} target={target ?? null} reveal={reveal ?? null} onPicked={onPicked}>{children}</ProjectFilesOr>
        : children}
    </div>
  );
}

// Kept for the page's life: the spaces made here before the reads that would carry them come back,
// the project Files last showed (beside a file in My files, its Project files), and each place's choice.
const madeProjectFiles = new Map<string, string>();
let madeMyFiles: string | null = null;
let lastProject: string | null = null;
const choices = new Map<string, FilesChoice>();
const CHOICE_EVENT = 'termag:files-choice';

/**
 * Show a session's Project files (the header's Project files chip): that session's Files goes back to Project files
 * from My files or one of Other spaces, mounted or not. The caller opens the panel on Files.
 */
export function showProjectFiles(projectId: string, workstream: string): void {
  const place = `session:${projectId}|${workstream}`;
  choices.set(place, { kind: 'project' });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CHOICE_EVENT, { detail: place }));
}

function errorOf(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

/** Project files | My files where there's a project of the person's to show, else `children` (Files as before). */
function ProjectFilesOr({ children, project, workstream, target, reveal, onPicked }: {
  children?: React.ReactNode; project?: Project; workstream: string; target: FilesToolTarget | null;
  reveal: { dir: string; n: number } | null; onPicked?: () => void;
}) {
  const { userProjects, spaces } = useSimpleData();
  const { user, noteMyFiles } = useAuth();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const myFiles = user?.myFilesSpace ?? madeMyFiles;
  const projects: FilesProject[] = (userProjects.list ?? []).filter(p => !p.archived)
    .map(p => ({ id: p.id, filesSpace: p.filesSpace?.name ?? madeProjectFiles.get(p.id) ?? null }));
  const sessionProject = project ? (project.role !== 'collaborator' ? project.userProjectId ?? null : null) : null;
  const projectId = filesProjectOf({ sessionProject, space: project ? null : target?.space, projects, myFiles, lastProject });
  const up = projectId ? projects.find(p => p.id === projectId) ?? null : null;
  const place = project ? `session:${project.id}|${workstream}` : `space:${target?.space ?? ''}`;
  // The place's pick, else its default, worked out on every render until a pick: a file page reloaded before the
  // projects are read must still open on its project's files once they are.
  const [picked, setPicked] = useState<{ place: string; choice: FilesChoice } | null>(null);
  const choice = (picked?.place === place ? picked.choice : choices.get(place)) ?? initialFilesChoice(project ? null : target?.space, up, myFiles);
  const setChoice = (c: FilesChoice) => { choices.set(place, c); setPicked({ place, choice: c }); };
  // The header's chip asked for this place's Project files.
  useEffect(() => {
    const onAsk = (e: Event) => { if ((e as CustomEvent<string>).detail === place) setPicked({ place, choice: { kind: 'project' } }); };
    window.addEventListener(CHOICE_EVENT, onAsk);
    return () => window.removeEventListener(CHOICE_EVENT, onAsk);
  }, [place]);
  if (projectId) lastProject = projectId;
  // Making the project's files, or My files, the first time they're needed.
  const [making, setMaking] = useState<{ kind: 'project' | 'mine'; error: string | null } | null>(null);
  const [tries, retry] = useReducer((n: number) => n + 1, 0);
  const needsProject = choice.kind === 'project' && up != null && !up.filesSpace;
  const needsMine = choice.kind === 'mine' && !myFiles;
  useEffect(() => {
    if (!up || (!needsProject && !needsMine)) return undefined;
    let live = true;
    const kind = needsProject ? 'project' : 'mine';
    setMaking({ kind, error: null });
    const made = kind === 'project'
      ? userProjectsApi.ensureFiles(up.id).then(v => { if (v.filesSpace) madeProjectFiles.set(up.id, v.filesSpace.name); userProjects.reload?.(); })
      : authApi.ensureMyFiles().then(r => { madeMyFiles = r.myFilesSpace; noteMyFiles(r.myFilesSpace); });
    made.then(() => { if (live) { setMaking(null); rerender(); } })
      .catch(err => { if (live) setMaking({ kind, error: errorOf(err, kind === 'project' ? 'Could not set up Project files' : 'Could not set up My files') }); });
    return () => { live = false; };
  }, [up?.id, needsProject, needsMine, tries]); // eslint-disable-line react-hooks/exhaustive-deps
  // Move to My files / Move to Project files: same path; asks before replacing; says why a refusal left it.
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [conflict, setConflict] = useState<{ path: string; from: string; to: string; fromLabel: FilesPlace; toLabel: FilesPlace } | null>(null);
  useEffect(() => {
    if (note?.tone !== 'ok') return undefined;
    const t = window.setTimeout(() => setNote(n => (n === note ? null : n)), 5000);
    return () => window.clearTimeout(t);
  }, [note]);
  const move = async (m: { path: string; from: string; to: string | null; fromLabel: FilesPlace; toLabel: FilesPlace }, force = false) => {
    const name = fileName(m.path);
    setNote(null);
    try {
      // The other side may not be made yet: make it first, as picking it would.
      let to = m.to;
      if (!to && m.toLabel === 'My files') { to = (await authApi.ensureMyFiles()).myFilesSpace; madeMyFiles = to; noteMyFiles(to); }
      if (!to && m.toLabel === 'Project files' && up) {
        const v = await userProjectsApi.ensureFiles(up.id);
        to = v.filesSpace?.name ?? null;
        if (to) madeProjectFiles.set(up.id, to);
      }
      if (!to) { setNote({ text: moveFailureText(null, { name, path: m.path, from: m.fromLabel, to: m.toLabel }), tone: 'error' }); return; }
      const r = await spacesApi.moveTo(m.from, { path: m.path, toSpace: to, ...(force ? { force: true } : {}) });
      // Each side lists afresh the next time an explorer shows it. One on screen now (the source, or the destination
      // switched to mid-move) keeps its loaded pages and its live refetch, which catches the move; dropping its
      // listings under it could leave a load in flight discarded and the explorer stuck on Loading.
      forgetListingsWhenNextShown(to);
      if (r.ok) forgetListingsWhenNextShown(m.from);
      setNote(r.ok
        ? { text: `Moved ${name} to ${m.toLabel}.`, tone: 'ok' }
        : { text: moveHalfDoneText({ name, from: m.fromLabel, to: m.toLabel }), tone: 'error' });
    } catch (err) {
      const data = (err as { response?: { data?: { code?: string; error?: string } } })?.response?.data;
      // Changed while moving: the moved version is in the other side now.
      if (data?.code === 'changed_while_moving' && m.to) forgetListingsWhenNextShown(m.to);
      if (data?.code === 'exists' && !force && m.to) { setConflict({ ...m, to: m.to }); return; }
      if (data?.code === 'exists' && !force) {
        const to = m.toLabel === 'My files' ? madeMyFiles : up ? madeProjectFiles.get(up.id) ?? null : null;
        if (to) { setConflict({ ...m, to }); return; }
      }
      setNote({ text: moveFailureText(data, { name, path: m.path, from: m.fromLabel, to: m.toLabel }), tone: 'error' });
    }
  };
  if (!sessionProject && !projectId) {
    // A file page whose space may be a project's files or My files: wait for the projects before choosing.
    if (!project && target?.space && !userProjects.settled) return <FilesShell head={null}><p className="fx-note">Loading…</p></FilesShell>;
    return <>{children}</>;
  }
  // The projects not read yet (or a project of the person's this page doesn't know): the explorer's loading rows.
  if (!up) {
    if (userProjects.settled && sessionProject) return <>{children}</>;
    return <FilesShell head={null}><p className="fx-note">Loading…</p></FilesShell>;
  }
  const others = otherSpaces(spaces.spaces, projects, myFiles);
  const space = choice.kind === 'project' ? up.filesSpace : choice.kind === 'mine' ? myFiles : choice.space;
  const head = (<>
    <ToggleButtonGroup aria-label="Which files" selectionMode="single" disallowEmptySelection appearance="elevated" className="chat-view-segment ft-switch"
      selectedKeys={choice.kind === 'other' ? new Set() : new Set([choice.kind])}
      onSelectionChange={keys => { const k = [...keys][0]; if (k === 'project' || k === 'mine') setChoice({ kind: k }); }}>
      <ToggleButton id="project" size="small">Project files</ToggleButton>
      <ToggleButton id="mine" size="small">My files</ToggleButton>
    </ToggleButtonGroup>
    {choice.kind === 'other' && <span className="fx-panel-title ft-other-title" data-tip={choice.space}>{choice.space}</span>}
  </>);
  const shown = target && space === target.space ? target : null;
  return (
    <>
      {space ? (
        <ExplorerPanel key={space} space={space} head={head} onPicked={onPicked} filesOnly={choice.kind !== 'other'}
          fileActions={choice.kind === 'other' ? undefined : path => [choice.kind === 'project'
            ? { label: 'Move to My files', onSelect: () => { void move({ path, from: space, to: myFiles, fromLabel: 'Project files', toLabel: 'My files' }); } }
            : { label: 'Move to Project files', onSelect: () => { void move({ path, from: space, to: up.filesSpace, fromLabel: 'My files', toLabel: 'Project files' }); } }]}
          activePath={shown?.activePath} activeDir={shown?.activeDir} activeAgent={target?.activeAgent}
          reveal={shown ? reveal ?? undefined : undefined}
          empty={choice.kind === 'other' ? undefined : (
            <EmptyState size={null} className="ft-empty">
              <Heading level={5}>Nothing here yet</Heading>
              <Text>Files you and your agents save for termag land here.</Text>
            </EmptyState>
          )} />
      ) : (
        <FilesShell head={head}>
          {making?.error ? (
            <p className="fx-note fx-error">
              {making.error} <Button variant="minimal" size="small" className="ft-retry" onPress={retry}>Retry</Button>
            </p>
          ) : <p className="fx-note" role="status">{choice.kind === 'mine' ? 'My files are being set up…' : 'Project files are being set up…'}</p>}
        </FilesShell>
      )}
      {note && <p className={`fx-note ft-note${note.tone === 'error' ? ' fx-error' : ''}`} role={note.tone === 'error' ? 'alert' : 'status'}>{note.text}</p>}
      {conflict && (
        <ModalOverlay isOpen isDismissable onOpenChange={o => { if (!o) setConflict(null); }} className={LP_THEME}>
          <Modal size="small" className="chat-archived-confirm">
            <Dialog role="alertdialog" className="chat-archived-confirm-dialog">
              <Heading slot="title" level={2} size="medium">Replace {fileName(conflict.path)} in {conflict.toLabel}?</Heading>
              <Text elementType="p" slot="subtitle">{conflict.toLabel} already has {conflict.path}. Replacing it keeps only the one you're moving from {conflict.fromLabel}.</Text>
              <ButtonGroup className="chat-archived-confirm-buttons">
                <Button variant="minimal" onPress={() => setConflict(null)}>Cancel</Button>
                <Button variant="destructive" autoFocus onPress={() => { const c = conflict; setConflict(null); void move(c, true); }}>Replace</Button>
              </ButtonGroup>
            </Dialog>
          </Modal>
        </ModalOverlay>
      )}
      {others.length > 0 && <OtherSpaces names={others} current={choice.kind === 'other' ? choice.space : null} onPick={name => setChoice({ kind: 'other', space: name })} />}
    </>
  );
}

/** The explorer's frame, for its states before there's a space to explore. */
function FilesShell({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return (
    <aside className="fx-panel" aria-label="Files">
      <div className="fx-panel-head">{head}</div>
      <div className="fx-panel-body">{children}</div>
    </aside>
  );
}

/** Other spaces the person reaches (team spaces, ones shared with them), folded to start; picking one explores it. */
function OtherSpaces({ names, current, onPick }: { names: string[]; current: string | null; onPick: (name: string) => void }) {
  const [unfolded, setUnfolded] = useState(() => readStoredYes(storage(), FILES_TOOL_OTHER_OPEN_KEY));
  const toggle = () => setUnfolded(u => { writeStoredYes(storage(), FILES_TOOL_OTHER_OPEN_KEY, !u); return !u; });
  return (
    <section className="ft-open ft-other" aria-label="Other spaces">
      <Button variant="minimal" className="ft-head" aria-expanded={unfolded} aria-controls="ft-other-list" onPress={toggle}
        data-tip={unfolded ? 'Fold other spaces' : 'Show other spaces'}>
        <span className="ft-title">Other spaces</span>
        <span className="ft-count">{names.length}</span>
        <span className="ft-caret" data-open={unfolded || undefined} aria-hidden="true"><Icon name="chevron-right" size="small" /></span>
      </Button>
      {unfolded && (
        <ul className="ft-list" id="ft-other-list">
          {names.map(name => (
            <li key={name} className="ft-item">
              <Button variant="minimal" className={`fx-row ft-row ft-pick${name === current ? ' active' : ''}`} aria-current={name === current ? 'true' : undefined}
                onPress={() => onPick(name)} data-tip={`Explore ${name}`}>
                <span className="fx-icon" aria-hidden="true"><FolderIcon /></span>
                <span className="ft-text"><span className="fx-name ft-name-full">{name}</span></span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function OpenList({ open, activeTab, onPicked }: { open: FileTab[]; activeTab: string | null; onPicked?: () => void }) {
  const [folded, setFolded] = useState(() => readOpenFolded(storage()));
  const panelFiles = usePanelFiles();
  const close = useCloseTabs(useTabGroups());
  const toggle = () => setFolded(f => { writeOpenFolded(storage(), !f); return !f; });
  // Folded, the tab on screen still shows, as a folded group in the sidebar keeps its open row.
  const shown = folded ? open.filter(i => i.id === activeTab) : open;
  return (
    <section className="ft-open" aria-label="Open files">
      <Button variant="minimal" className="ft-head" aria-expanded={!folded} aria-controls="ft-open-list" onPress={toggle}
        data-tip={folded ? 'Show open files' : 'Fold open files'}>
        <span className="ft-title">Open</span>
        <span className="ft-count">{open.length}</span>
        <span className="ft-caret" data-open={!folded || undefined} aria-hidden="true"><Icon name="chevron-right" size="small" /></span>
      </Button>
      {shown.length > 0 && (
        <ul className="ft-list" id="ft-open-list">
          {shown.map(item => {
            const name = openItemName(item);
            const where = openItemWhere(item);
            const isOpen = item.id === activeTab;
            // A file tab of the panel's shows there; its link is the file's page, for a new browser tab.
            const inPanel = panelFiles != null && item.kind === 'file' && item.panel != null;
            return (
              <li key={item.id} className="ft-item">
                <Link to={inPanel ? itemHref(item) : itemHref(item, item.id)} className={`fx-row ft-row${isOpen ? ' active' : ''}`} aria-current={isOpen ? 'page' : undefined}
                  data-tip={openItemTip(item)}
                  onClick={e => {
                    if (!plainClick(e)) return;
                    if (inPanel) { e.preventDefault(); panelFiles.show(item.id); } else onPicked?.();
                  }}>
                  <span className="fx-icon" aria-hidden="true">{item.kind === 'file' ? <FileIcon /> : <FolderIcon />}</span>
                  <span className="ft-text">
                    <span className="fx-name">{name}</span>
                    {where && <span className="ft-where">{where}</span>}
                  </span>
                </Link>
                <TooltipTrigger delay={300}>
                  <IconButton icon="cancel" size="small" variant="minimal" className="ft-close" aria-label={`Close ${name}`}
                    onPress={() => { close([item.id]); }} />
                  <Tooltip placement="left" className={LP_THEME}>Close</Tooltip>
                </TooltipTrigger>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
