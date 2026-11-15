// New session's project pill (under
// user-projects-enabled): "What are we doing in termag?", where termag is the
// project, not a repository. Its menu is LaunchPad's, built to pick fast: a
// search over the person's projects, most recently active first, one line each
// with its repositories muted at the right, the picked one tinted with an
// accent bar and a check. From a repository… (today's repository picker, which
// the parent shows instead) and + New project are pinned under the list, always
// in view, on ⌥R and ⌥N.
//
// + New project lives in the same search, with no form. A name that matches no
// project offers + New project “…”: ↵ makes it and picks it. ⌥↵ adds
// repositories first, in a step that takes the whole popover (RepoStep.tsx). A
// repository matching the name offers From owner/repo, a project with it in one
// go. A name the person already has says so on its row as they type: ↵ picks
// that project, or for an archived one unarchives it. The draft (the search,
// the step, the repositories picked) outlives Esc, Back and a click outside,
// until a project is picked or made. Add a repository to <project>… is the same
// step. Archived projects and projects shared with the person aren't offered:
// GET /api/user-projects lists only their own, and an archived one is left out
// here. The parent holds the pick and whether the menu is open.
import React, { useEffect, useRef, useState } from 'react';
import '@launchpad-ui/tokens/index.css';
import {
  Autocomplete, Button, Dialog, DialogTrigger, Group, Header, Input, ListBox, ListBoxItem, ListBoxSection, Popover, Pressable, SearchField, Text,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';
import { userProjectsApi, type UserProjectView } from '../../services/api';
import {
  listedRepo, nameMatch, offeredProjects, pastedRepo, pickedReposBody, projectRowRepos, type PickedRepo,
} from '../../chat/projectPick';
import { useRepoCatalog } from '../../chat/useRepoCatalog';
import { RepoStep } from './RepoStep';
import { effectivePick, pickSrc, ProjectIconPicker, useRepoIconCandidates, type IconPick } from './ProjectIconPicker';
import type { ProjectIconCandidate } from '../../services/api';

/** The person's projects as New session reads them (chat/useUserProjectList.ts). */
export type ProjectsState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; projects: UserProjectView[] };

/** The menu's From a repository… row (kept for callers; the menu pins it as a button). */
export const FROM_REPOSITORY = 'from-repository';
/** The menu's + New project “…” row, for a name that matches no project. */
export const NEW_PROJECT = 'new-project';
/** The menu's Unarchive “…” row, for a name an archived project of the person's holds. */
export const UNARCHIVE = 'unarchive';
/** The menu's Add a repository to <project>… row. */
export const ADD_REPO = 'add-repo';
/** A From owner/repo row's id prefix. */
const FROM_REPO = 'repo:';

/** Mirrors backend services/projectRepos.ts MULTI_REPO_MAX: what a project holds. */
export const PROJECT_REPO_MAX = 8;
/** How many From owner/repo rows a name offers at most. */
const REPO_MATCHES = 4;

/** The menu's shortcuts: ⌥ on a Mac, Alt elsewhere, as the browser reports the key held. */
const ALT_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌥' : 'Alt+';

/** Whether a project matches the menu's search: its name, or one of its repositories' owner/name. */
export function projectMatches(project: Pick<UserProjectView, 'name' | 'repos'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || project.name.toLowerCase().includes(q) || project.repos.some(r => r.repoKey.toLowerCase().includes(q));
}

type Step = 'menu' | 'repos' | 'add-repo';

function apiFailure(err: unknown, fallback: string): { code?: string; text: string } {
  const data = (err as { response?: { data?: { error?: string; code?: string } } })?.response?.data;
  return { code: data?.code, text: data?.error ?? fallback };
}

export function ProjectPicker({ state, selected, onSelect, onFromRepository, onCreated, multiRepo = false, open, onOpenChange, disabled = false }: {
  state: ProjectsState;
  /** The project New session starts in, or null ("Pick a project"). */
  selected: UserProjectView | null;
  onSelect: (project: UserProjectView) => void;
  /** From a repository…: the parent swaps in the repository picker, open. */
  onFromRepository: () => void;
  /** A project made here, unarchived, or given a repository: the parent lists it, picks it and focuses the message. */
  onCreated: (project: UserProjectView) => void;
  /** multi-repo-projects-enabled: a new project takes up to 8 repositories, else one. */
  multiRepo?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}) {
  // The draft: kept when the menu closes (Esc, a click outside), dropped once a project is picked or made.
  const [query, setQuery] = useState('');
  const [step, setStep] = useState<Step>('menu');
  const [picked, setPicked] = useState<PickedRepo[]>([]);
  // A refused or failed create, unarchive or add, said on the row (or over the step's action) it came from; ↵ retries.
  const [failure, setFailure] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // The repositories step's icon: Automatic unless the person picks one. Held
  // here with the candidates read and any upload, so they're part of the draft and outlive Back.
  const [iconPick, setIconPick] = useState<IconPick>({ choice: 'auto' });
  const [iconUploads, setIconUploads] = useState<ProjectIconCandidate[]>([]);
  const [iconBusy, setIconBusy] = useState(false);
  // One write at a time: ↵ reaches both React Aria's row and the menu's own handler.
  const writing = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const catalog = useRepoCatalog(open);
  const pickedKeys = picked.map(r => r.fullName.toLowerCase());
  // New project's draft (its repositories step, and the menu it goes Back to, which keeps the draft and so
  // this read); Add a repository, which shows no icon, never looks one up.
  const iconRead = useRepoIconCandidates(step === 'add-repo' ? [] : pickedKeys);
  useEffect(() => { if (open) void ensureLaunchPadSprite(); }, [open]);

  const loading = state.kind === 'loading';
  const all = state.kind === 'ready' ? state.projects : [];
  const projects = offeredProjects(all);
  const typed = query.trim();
  const shown = projects.filter(p => projectMatches(p, query));
  const name = nameMatch(all, typed);
  // A repository whose name is the one typed, or a URL or owner/name pasted: a project with it in one go.
  const pasted = pastedRepo(typed);
  // Not one whose project name (the repository's) the person already has: its create could only be refused.
  const repoName = (r: PickedRepo) => r.fullName.slice(r.fullName.indexOf('/') + 1);
  const repoMatches: PickedRepo[] = (!typed ? [] : pasted ? [pasted]
    : catalog.kind === 'ready'
      ? catalog.repos.filter(r => r.fullName.toLowerCase().includes(typed.toLowerCase())).map(listedRepo)
      : []).filter(r => nameMatch(all, repoName(r)).kind === 'free').slice(0, REPO_MATCHES);
  // + New project “…” once the name matches none of the person's projects (a partial match is still a search).
  const offerNew = typed !== '' && name.kind === 'free' && !pasted && shown.length === 0;
  // Add a repository to the project picked: a project holds 8 (disabled there, saying why), and while multi-repo
  // projects are off, one (not offered once it has it).
  const addRepo = selected && (multiRepo || selected.repos.length === 0) ? { full: selected.repos.length >= PROJECT_REPO_MAX } : null;
  const label = loading ? 'Loading projects…' : selected ? selected.name : 'Pick a project';

  function clearDraft() {
    setQuery('');
    setStep('menu');
    setPicked([]);
    setFailure(null);
    setIconPick({ choice: 'auto' });
    setIconUploads([]);
  }
  function done(project: UserProjectView) {
    clearDraft();
    onOpenChange(false);
    onCreated(project);
  }

  async function write(key: string, run: () => Promise<UserProjectView>, fallback: string) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setFailure(null);
    try {
      done(await run());
    } catch (err) {
      const { code, text } = apiFailure(err, fallback);
      setFailure({ key, text: code === 'user_project_name_taken' ? text : `${text}. ↵ to try again` });
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  const create = (key: string, projectName: string, repos: readonly PickedRepo[]) =>
    write(key, () => userProjectsApi.create({ name: projectName, repos: pickedReposBody(repos) }), "Couldn't make the project");
  // The repositories step's create, then its icon if one was picked. The project stands either way: an icon
  // that wouldn't save leaves it Automatic, and Change icon… is in its menu.
  const createWithIcon = (projectName: string, repos: readonly PickedRepo[]) => write('repos', async () => {
    // What the picker shows: a pick whose tile isn't (still reading, a repository since unpicked) is Automatic.
    const pick = effectivePick(pickedKeys, iconRead, iconUploads, iconPick);
    const made = await userProjectsApi.create({ name: projectName, repos: pickedReposBody(repos) });
    if (pick.choice === 'auto') return made;
    try {
      await userProjectsApi.setIcon(made.id, pick);
      // With its image, so the sidebar draws it now rather than after the next read of the projects.
      return { ...made, icon: { choice: pick.choice, imageId: pick.choice === 'image' ? pick.iconId : null, src: pickSrc(iconRead, iconUploads, pick) } };
    } catch {
      return made;
    }
  }, "Couldn't make the project");
  const unarchive = (project: UserProjectView) =>
    write(UNARCHIVE, () => userProjectsApi.update(project.id, { archived: false }), "Couldn't unarchive it");

  function newProject() {
    // A name to start from: ⌥↵ or the pinned button with one typed goes to its repositories; with none, the search asks for one.
    if (typed && name.kind === 'free') { setFailure(null); setStep('repos'); return; }
    if (!typed) searchRef.current?.focus();
  }
  function fromRepository() {
    clearDraft();
    onOpenChange(false);
    onFromRepository();
  }

  // One row is picked at a time; picking the one already picked (React Aria's single selection unselects it) just closes.
  function onSelectionChange(keys: 'all' | Set<React.Key>) {
    const key = keys === 'all' ? null : [...keys][0] ?? null;
    if (key === NEW_PROJECT) { void create(NEW_PROJECT, typed, []); return; }
    if (key === UNARCHIVE && name.kind === 'archived') { void unarchive(name.project); return; }
    if (key === ADD_REPO) { setPicked([]); setFailure(null); setStep('add-repo'); return; }
    if (typeof key === 'string' && key.startsWith(FROM_REPO)) {
      const repo = repoMatches.find(r => FROM_REPO + r.fullName === key);
      if (repo) void create(key, repoName(repo), [repo]);
      return;
    }
    const project = projects.find(p => p.id === key);
    clearDraft();
    onOpenChange(false);
    if (project) onSelect(project);
  }

  function onMenuKeyDownCapture(e: React.KeyboardEvent) {
    const onAction = (e.target as HTMLElement).closest?.('.chat-project-actions') != null;
    // Autocomplete re-dispatches the search's keys onto the list (virtual focus): those copies are React Aria's.
    if ((e.target as HTMLElement).closest?.('.chat-project-list') != null) return;
    // Esc closes the menu but keeps what was typed (the search would clear it first).
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onOpenChange(false); return; }
    // ⌥↵ on a new name: its repositories first.
    if (e.key === 'Enter' && e.altKey && !onAction) { e.preventDefault(); e.stopPropagation(); newProject(); return; }
    // ↵ on a new name makes it; on a taken one, picks or unarchives it. Autocomplete highlights the first
    // match as you type, but not a row that only appears once nothing else matches, so the menu takes ↵ itself,
    // unless a From owner/repo row is highlighted (arrowed to), whose ↵ is React Aria's.
    const onFromRow = highlightedKey()?.startsWith(FROM_REPO) ?? false;
    if (e.key === 'Enter' && !onAction && !onFromRow && !e.metaKey && !e.ctrlKey && !e.shiftKey && typed) {
      if (offerNew) { e.preventDefault(); e.stopPropagation(); void create(NEW_PROJECT, typed, []); return; }
      if (name.kind === 'archived') { e.preventDefault(); e.stopPropagation(); void unarchive(name.project); return; }
      if (name.kind === 'live') { e.preventDefault(); e.stopPropagation(); onSelectionChange(new Set([name.project.id])); return; }
    }
    if (!e.altKey || e.metaKey || e.ctrlKey) return;
    // ⌥N / ⌥R by the key's position, as ⌥ changes the character a Mac types.
    if (e.code === 'KeyN') { e.preventDefault(); e.stopPropagation(); newProject(); }
    else if (e.code === 'KeyR') { e.preventDefault(); e.stopPropagation(); fromRepository(); }
  }

  // The row Autocomplete has highlighted (its virtual focus, the search's active descendant), by key.
  function highlightedKey(): string | null {
    const id = searchRef.current?.getAttribute('aria-activedescendant');
    return id ? document.getElementById(id)?.closest('[data-key]')?.getAttribute('data-key') ?? null : null;
  }

  const rowNote = (key: string, normal: string | null) => (failure?.key === key ? failure.text : normal);
  const rowFailed = (key: string) => failure?.key === key;

  return (
    <div className="chat-compose-repo chat-project-pick">
      <DialogTrigger isOpen={open} onOpenChange={onOpenChange}>
        {/* termag's own trigger (the sentence's underlined subject, as the repository pill's), pressed through LaunchPad's Pressable. */}
        <Pressable isDisabled={loading || disabled}>
          <button
            type="button"
            className="chat-compose-repo-btn"
            data-empty={selected ? undefined : ''}
            aria-label={selected ? `Project: ${selected.name}` : label}
            disabled={loading || disabled}
          >
            <span className="chat-compose-repo-name">{label}</span>
          </button>
        </Pressable>
        <Popover placement="bottom start" className={`${LP_THEME} chat-menu-popover chat-project-popover`}>
          <Dialog aria-label={step === 'repos' ? 'New project' : step === 'add-repo' ? 'Add a repository' : 'Projects'} className="chat-project-dialog">
            {step === 'repos' ? (
              <RepoStep
                title={`New project “${typed}”`}
                catalog={catalog}
                onRetryCatalog={catalog.retry}
                picked={picked}
                onPicked={setPicked}
                max={multiRepo ? PROJECT_REPO_MAX : 1}
                action={`Create “${typed}”`}
                onAction={() => { if (!iconBusy) void createWithIcon(typed, picked); }}
                busy={busy || iconBusy}
                error={failure?.key === 'repos' ? failure.text : null}
                note={picked.length === 0 ? 'no repository yet' : `${picked.length} ${picked.length === 1 ? 'repository' : 'repositories'}`}
                onBack={() => { setFailure(null); setStep('menu'); }}
                extra={picked.length > 0
                  ? <ProjectIconPicker repoKeys={pickedKeys} read={iconRead} value={iconPick} onChange={setIconPick} size={13}
                      uploads={iconUploads} onUploaded={u => setIconUploads(list => [...list.filter(x => x.id !== u.id), u])}
                      onBusyChange={setIconBusy} />
                  : null}
              />
            ) : step === 'add-repo' && selected ? (
              <RepoStep
                title={`Add a repository to ${selected.name}`}
                catalog={catalog}
                onRetryCatalog={catalog.retry}
                picked={picked}
                onPicked={setPicked}
                max={1}
                exclude={selected.repos.map(r => r.repoKey)}
                action={`Add to ${selected.name}`}
                onAction={() => {
                  const [repo] = pickedReposBody(picked);
                  if (!repo) { setFailure({ key: 'add-repo', text: 'Pick a repository to add' }); return; }
                  void write('add-repo', () => userProjectsApi.addRepo(selected.id, repo), "Couldn't add the repository");
                }}
                busy={busy}
                error={failure?.key === 'add-repo' ? failure.text : null}
                note="its new sessions clone it"
                onBack={() => { setFailure(null); setPicked([]); setStep('menu'); }}
              />
            ) : (
            // Not a form: the search and its list, with the two ways to start pinned under them.
            <div className="chat-project-picker-menu" onKeyDownCapture={onMenuKeyDownCapture}>
            <Autocomplete inputValue={query} onInputChange={q => { setQuery(q); setFailure(null); }}>
              <SearchField aria-label="Search projects" autoFocus className={`${LP_THEME} chat-env-search chat-project-search`}>
                <Group className="chat-env-search-group">
                  <Icon name="search" size="medium" className="chat-env-search-icon" aria-hidden="true" />
                  <Input ref={searchRef} placeholder="Find a project, or type a new name" />
                </Group>
              </SearchField>
              {/* The first match is highlighted as you type (Autocomplete's virtual focus), so ↵ takes it. */}
              <ListBox
                aria-label="Projects"
                autoFocus="first"
                className="chat-project-list"
                selectionMode="single"
                selectedKeys={selected ? [selected.id] : []}
                onSelectionChange={onSelectionChange}
              >
                {offerNew ? (
                  <ListBoxItem id={NEW_PROJECT} textValue={`New project ${typed}`} className="chat-project-option chat-project-create" data-failed={rowFailed(NEW_PROJECT) || undefined}>
                    <Text slot="label">+ New project “{typed}”</Text>
                    <Text slot="description">{rowNote(NEW_PROJECT, `↵ create · ${ALT_KEY}↵ repositories`)}</Text>
                  </ListBoxItem>
                ) : null}
                {name.kind === 'archived' ? (
                  <ListBoxItem id={UNARCHIVE} textValue={`Unarchive ${name.project.name}`} className="chat-project-option chat-project-unarchive" data-failed={rowFailed(UNARCHIVE) || undefined}>
                    <Text slot="label">Unarchive “{name.project.name}”</Text>
                    <Text slot="description">{rowNote(UNARCHIVE, 'archived · ↵ brings it back')}</Text>
                  </ListBoxItem>
                ) : null}
                {shown.map(p => {
                  const taken = name.kind === 'live' && name.project.id === p.id;
                  const repos = taken ? 'yours already · ↵ picks it' : projectRowRepos(p);
                  return (
                    <ListBoxItem key={p.id} id={p.id} textValue={p.name} className="chat-project-option">
                      <Text slot="label">{p.name}</Text>
                      {repos ? <Text slot="description">{repos}</Text> : null}
                    </ListBoxItem>
                  );
                })}
                {repoMatches.length > 0 ? (
                  <ListBoxSection id="from-repo" className="chat-project-section">
                    <Header className="chat-project-section-head">New project from a repository</Header>
                    {repoMatches.map(r => (
                      <ListBoxItem key={r.fullName} id={FROM_REPO + r.fullName} textValue={r.fullName} className="chat-project-option" data-failed={rowFailed(FROM_REPO + r.fullName) || undefined}>
                        <Text slot="label">From {r.fullName}</Text>
                        <Text slot="description">{rowNote(FROM_REPO + r.fullName, '↵ new project')}</Text>
                      </ListBoxItem>
                    ))}
                  </ListBoxSection>
                ) : null}
                {addRepo && !typed ? (
                  <ListBoxItem id={ADD_REPO} textValue={`Add a repository to ${selected!.name}`} className="chat-project-option chat-project-add-repo" isDisabled={addRepo.full}>
                    <Text slot="label">Add a repository to {selected!.name}…</Text>
                    {addRepo.full ? <Text slot="description">{`${PROJECT_REPO_MAX} is the most a project holds`}</Text> : null}
                  </ListBoxItem>
                ) : null}
              </ListBox>
            </Autocomplete>
            <div className="chat-project-actions">
              <Button size="small" className="chat-project-action" onPress={fromRepository}>
                From a repository… <span className="chat-project-key" aria-hidden="true">{ALT_KEY}R</span>
              </Button>
              <Button size="small" className="chat-project-action" onPress={newProject}>
                + New project <span className="chat-project-key" aria-hidden="true">{ALT_KEY}N</span>
              </Button>
            </div>
            </div>
            )}
          </Dialog>
        </Popover>
      </DialogTrigger>
    </div>
  );
}
