// @vitest-environment jsdom
// A project's menu:
// New session here, Rename (a taken name on the field, any other failure an Alert, what
// was typed kept) and Archive (what each box does, and a checkout left behind).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveProjectDialog, archiveLeftLines, boxFateLine, labLine, ProjectMenu, ProjectShareDialog, RenameProjectDialog } from './ProjectMenu';
import { clearRunningBox, readRunningBox } from '../../chat/archive';

const mocks = vi.hoisted(() => ({
  update: vi.fn(async (): Promise<unknown> => ({ id: 'up-1', name: 'Termag web' })),
  archivePlan: vi.fn(async (): Promise<unknown> => ({
    id: 'up-1', name: 'termag', archived: false, sessions: 4,
    checkouts: [],
    boxes: [
      { boxId: 'a', boxName: 'box-a', fate: 'stops', why: 'nothing-else' },
      { boxId: 'b', boxName: 'box-b', fate: 'keeps', why: 'other-sessions' },
      { boxId: 'c', boxName: 'box-c', fate: 'keeps', why: 'lab-session' },
    ],
  })),
  reloadUserProjects: vi.fn(async () => {}),
  reloadProjects: vi.fn(async () => {}),
  // Share… (project-files-enabled): the project's Project files and the spaces ChatApp read.
  projectFiles: false,
  userProjects: [] as Array<{ id: string; filesSpace: { name: string } | null }>,
  spaces: [] as Array<{ id: string; name: string; role: string }>,
  reloadSpaces: vi.fn(async () => {}),
  ensureFiles: vi.fn(async (): Promise<unknown> => ({ id: 'up-1', filesSpace: { name: 'termag-files' } })),
  getSpace: vi.fn(async (name: string): Promise<unknown> => ({ space: { id: 'sp-1', name, role: 'owner' } })),
}));
vi.mock('../../flags', async importOriginal => {
  const actual = await importOriginal<typeof import('../../flags')>();
  return { ...actual, useFlag: <T,>(key: string, fallback: T) => (key === 'project-files-enabled' ? mocks.projectFiles as T : fallback) };
});
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-1' } }) }));
// The real dialog reads the space's people and boxes; this one says what it was given.
vi.mock('./SpaceShareDialog', () => ({
  SpaceShareDialog: ({ space, label, onLeft }: { space: { name: string }; label?: string; onLeft: () => void }) => (
    <div className="share-stub" data-space={space.name}>Share {label}<button type="button" onClick={onLeft}>Leave</button></div>
  ),
}));
vi.mock('../../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    userProjectsApi: { ...actual.userProjectsApi, update: mocks.update, archivePlan: mocks.archivePlan, ensureFiles: mocks.ensureFiles },
    spacesApi: { ...actual.spacesApi, get: mocks.getSpace },
  };
});
vi.mock('./simpleData', () => ({ useSimpleDataIfAny: () => ({
  userProjects: { reload: mocks.reloadUserProjects, list: mocks.userProjects },
  spaces: { spaces: mocks.spaces, reload: mocks.reloadSpaces },
}) }));
vi.mock('../../contexts/ProjectContext', () => ({ useProjects: () => ({ reloadProjects: mocks.reloadProjects }) }));
vi.mock('../../services/boxFeed', () => ({ boxFeed: { reload: vi.fn(async () => {}) } }));

const project = { id: 'up-1', name: 'termag' };
let root: Root;
let host: HTMLDivElement;
let at = '';
function Where() { at = useLocation().pathname + useLocation().search; return null; }

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.update.mockReset().mockResolvedValue({ id: 'up-1', name: 'Termag web' });
  mocks.projectFiles = false;
  mocks.userProjects = [];
  mocks.spaces = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (node: React.ReactNode) => act(() => root.render(<MemoryRouter initialEntries={['/chat']}>{node}<Where /></MemoryRouter>));
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const press = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };
const buttonNamed = (name: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === name)!;
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('boxFateLine and archiveLeftLines', () => {
  it('says what happens to each box', () => {
    expect(boxFateLine({ boxId: 'a', boxName: 'box-a', fate: 'stops', why: 'nothing-else' })).toBe('box-a stops: nothing else runs on it');
    expect(boxFateLine({ boxId: 'b', boxName: 'box-b', fate: 'keeps', why: 'other-sessions' })).toBe('box-b keeps running: other sessions use it');
    expect(boxFateLine({ boxId: 'c', boxName: 'box-c', fate: 'keeps', why: 'lab-session' })).toBe('box-c keeps running: a Lab session');
    expect(boxFateLine({ boxId: 'd', boxName: 'box-d', fate: 'keeps', why: 'not-powered', detail: 'the box is already stopped' }))
      .toBe('box-d stays as it is: the box is already stopped');
  });

  it("names the Lab checkouts, which reopen from Lab's archive", () => {
    expect(labLine({ checkouts: [{ projectId: 'c1', name: 'termag-1', kind: 'chat', sessions: 1, boxName: 'box-a' }] })).toBeNull();
    expect(labLine({ checkouts: [{ projectId: 's', name: 'sample', kind: 'lab', sessions: 1, boxName: 'box-a' }] }))
      .toBe("sample runs in Lab and reopens from Lab's archive.");
  });

  it('says which checkout is left and why', () => {
    expect(archiveLeftLines('termag', {
      archived: [{ projectId: 'c2', name: 'termag-2' }], failed: [{ projectId: 'c1', name: 'termag-1', status: 409, error: 'A turn is still running' }], boxes: [],
    })).toEqual(["termag-1 didn't archive: A turn is still running", 'termag stays live; 1 checkout was archived.']);
  });
});

describe('ProjectMenu', () => {
  it('offers New session here, Rename, Change icon and Archive, and New session here opens New session on the project', async () => {
    let open = true;
    const onDialog = vi.fn();
    const show = () => render(<ProjectMenu project={project} isOpen={open} onOpenChange={o => { open = o; show(); }} onDialog={onDialog} />);
    show();
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map(i => i.querySelector('[slot="label"]')?.textContent)).toEqual(['New session here', 'Rename project…', 'Change icon…', 'Archive project…']);
    await press(items[1]);
    expect(onDialog).toHaveBeenLastCalledWith({ kind: 'rename', project });
    open = true;
    show();
    await press([...document.querySelectorAll('[role="menuitem"]')][2]);
    expect(onDialog).toHaveBeenLastCalledWith({ kind: 'icon', project });
    open = true;
    show();
    await press([...document.querySelectorAll('[role="menuitem"]')][3]);
    expect(onDialog).toHaveBeenLastCalledWith({ kind: 'archive', project });
    open = true;
    show();
    await press([...document.querySelectorAll('[role="menuitem"]')][0]);
    expect(at).toBe('/chat/new?project=up-1');
    expect(host.querySelector('.chat-project-menu')?.getAttribute('aria-label')).toBe('Options for termag');
  });
});

// From review: "how do I share a project now?" Group by Space's heads, which had Share space, are gone under
// project-files-enabled, so a project shares its Project files from its own menu.
describe('Share…', () => {
  const menuLabels = () => [...document.querySelectorAll('[role="menuitem"]')].map(i => i.querySelector('[slot="label"]')?.textContent);
  const showMenu = (onDialog = vi.fn()) => render(<ProjectMenu project={project} isOpen onOpenChange={() => {}} onDialog={onDialog} />);

  it("is in the project's menu under project-files-enabled, beside Slack channels, saying what it shares", async () => {
    mocks.projectFiles = true;
    const onDialog = vi.fn();
    showMenu(onDialog);
    expect(menuLabels()).toEqual(['New session here', 'Rename project…', 'Change icon…', 'Use an existing space for files…', 'Share…', 'Archive project…']);
    const share = [...document.querySelectorAll('[role="menuitem"]')][4];
    expect(share.querySelector('[slot="description"]')?.textContent).toBe("People and boxes with access to termag's files");
    await press(share);
    expect(onDialog).toHaveBeenLastCalledWith({ kind: 'share', project });
  });

  it('is not there with the flag off', () => {
    showMenu();
    expect(menuLabels()).not.toContain('Share…');
  });

  it("opens the space share dialog on the project's Project files, called by the project", async () => {
    mocks.userProjects = [{ id: 'up-1', filesSpace: { name: 'termag-files' } }];
    mocks.spaces = [{ id: 'sp-1', name: 'termag-files', role: 'owner' }];
    render(<ProjectShareDialog project={project} onClose={() => {}} />);
    await flush();
    expect(document.querySelector('.share-stub')?.getAttribute('data-space')).toBe('termag-files');
    expect(document.querySelector('.share-stub')?.textContent).toContain("Share termag's files");
    expect(mocks.ensureFiles).not.toHaveBeenCalled();
  });

  it('makes Project files first when the project has none, as Files does on first use, then shares them', async () => {
    let made: (v: unknown) => void = () => {};
    mocks.ensureFiles.mockImplementationOnce(() => new Promise(r => { made = r; }));
    render(<ProjectShareDialog project={project} onClose={() => {}} />);
    expect(document.body.textContent).toContain("Setting up termag's files…");
    expect(mocks.ensureFiles).toHaveBeenCalledWith('up-1');
    // Made after the page read its spaces: it's read on its own, and the lists again.
    await act(async () => { made({ id: 'up-1', filesSpace: { name: 'termag-files' } }); });
    await flush();
    expect(mocks.getSpace).toHaveBeenCalledWith('termag-files');
    expect(mocks.reloadSpaces).toHaveBeenCalled();
    expect(mocks.reloadUserProjects).toHaveBeenCalled();
    expect(document.querySelector('.share-stub')?.getAttribute('data-space')).toBe('termag-files');
  });

  // Bugbot on #1872: Leave did what the other share dialogs' Leave does only half (no reload, no leaving the screen).
  it("hands Leave to the list, which reads the spaces again and leaves what's on screen in it", async () => {
    mocks.userProjects = [{ id: 'up-1', filesSpace: { name: 'termag-files' } }];
    mocks.spaces = [{ id: 'sp-1', name: 'termag-files', role: 'editor' }];
    const onClose = vi.fn();
    const onLeft = vi.fn();
    render(<ProjectShareDialog project={project} onClose={onClose} onLeft={onLeft} />);
    await flush();
    await press(buttonNamed('Leave'));
    expect(onClose).toHaveBeenCalled();
    expect(onLeft).toHaveBeenCalledWith('termag-files');
  });

  it('says Opening, not Setting up, while it only reads a space the project already has', async () => {
    mocks.userProjects = [{ id: 'up-1', filesSpace: { name: 'termag-files' } }];
    mocks.getSpace.mockImplementationOnce(() => new Promise(() => {}));
    render(<ProjectShareDialog project={project} onClose={() => {}} />);
    await flush();
    expect(document.body.textContent).toContain("Opening termag's files…");
    expect(document.body.textContent).not.toContain('Setting up');
    expect(mocks.ensureFiles).not.toHaveBeenCalled();
  });

  // Devin on #1872: the shared spaces read keeps its failures to itself, so a failed read left the dialog spinning.
  it("says so when it can't read the space it made, and Try again reads it again", async () => {
    mocks.getSpace.mockRejectedValueOnce(Object.assign(new Error('no'), { response: { status: 503, data: { error: 'Spaces are busy' } } }));
    render(<ProjectShareDialog project={project} onClose={() => {}} />);
    await flush();
    expect(document.body.textContent).toContain('Spaces are busy');
    expect(document.querySelector('.share-stub')).toBeNull();
    await press(buttonNamed('Try again'));
    await flush();
    expect(mocks.getSpace).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.share-stub')?.getAttribute('data-space')).toBe('termag-files');
  });

  it("says so when it can't make them, with Try again", async () => {
    mocks.ensureFiles.mockRejectedValueOnce(Object.assign(new Error('no'), { response: { status: 503, data: { error: 'Spaces are down' } } }));
    render(<ProjectShareDialog project={project} onClose={() => {}} />);
    await flush();
    expect(document.body.textContent).toContain('Spaces are down');
    await press(buttonNamed('Try again'));
    await flush();
    expect(mocks.ensureFiles).toHaveBeenCalledTimes(2);
  });
});

describe('RenameProjectDialog', () => {
  it('renames, reads the projects again and closes', async () => {
    const onClose = vi.fn();
    render(<RenameProjectDialog project={project} onClose={onClose} />);
    await type(document.querySelector<HTMLInputElement>('.chat-project-name-field input')!, '  Termag web ');
    await press(buttonNamed('Rename'));
    await flush();
    expect(mocks.update).toHaveBeenCalledWith('up-1', { name: 'Termag web' });
    expect(mocks.reloadUserProjects).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('says a taken name on the field, and an Alert for anything else, keeping what was typed', async () => {
    const onClose = vi.fn();
    render(<RenameProjectDialog project={project} onClose={onClose} />);
    const input = document.querySelector<HTMLInputElement>('.chat-project-name-field input')!;
    await type(input, 'docs');
    mocks.update.mockRejectedValueOnce({ response: { status: 409, data: { error: 'You already have a project called docs', code: 'user_project_name_taken', field: 'name' } } });
    await press(buttonNamed('Rename'));
    await flush();
    expect(document.querySelector('.chat-project-field-error')?.textContent).toBe('You already have a project called docs');
    expect(input.value).toBe('docs');
    mocks.update.mockRejectedValueOnce({ response: { status: 500, data: { error: 'Failed to change the project' } } });
    await press(buttonNamed('Rename'));
    await flush();
    expect([...document.querySelectorAll('.chat-project-dialog p')].some(p => p.textContent === 'Failed to change the project')).toBe(true);
    expect(document.querySelector('.chat-project-field-error')).toBeNull();
    expect(input.value).toBe('docs');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ArchiveProjectDialog', () => {
  it('asks first, saying what it takes and what each box does, then archives', async () => {
    const onClose = vi.fn();
    render(<ArchiveProjectDialog project={project} onClose={onClose} />);
    await flush();
    expect(document.querySelector('.chat-project-dialog h2')?.textContent).toBe('Archive termag and its 4 sessions?');
    expect([...document.querySelectorAll('.chat-project-boxes li')].map(li => li.textContent)).toEqual([
      'box-a stops: nothing else runs on it', 'box-b keeps running: other sessions use it', 'box-c keeps running: a Lab session',
    ]);
    await press(buttonNamed('Archive'));
    await flush();
    expect(mocks.update).toHaveBeenCalledWith('up-1', { archived: true });
    expect(mocks.reloadProjects).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('leaves the session on screen when its checkout went with the archive, and not otherwise', async () => {
    mocks.update.mockResolvedValueOnce({ id: 'up-1', name: 'termag', archive: { archived: [{ projectId: 'c1', name: 'termag-1' }], failed: [], boxes: [] } });
    act(() => root.render(<MemoryRouter initialEntries={['/chat/p/c1']}><ArchiveProjectDialog project={project} onClose={() => {}} /><Where /></MemoryRouter>));
    await flush();
    await press(buttonNamed('Archive'));
    await flush();
    expect(at).toBe('/chat');
    act(() => root.render(<></>));
    mocks.update.mockResolvedValueOnce({ id: 'up-1', name: 'termag', archive: { archived: [{ projectId: 'c1', name: 'termag-1' }], failed: [], boxes: [] } });
    act(() => root.render(<MemoryRouter initialEntries={['/chat/p/other']}><ArchiveProjectDialog project={project} onClose={() => {}} /><Where /></MemoryRouter>));
    await flush();
    await press(buttonNamed('Archive'));
    await flush();
    expect(at).toBe('/chat/p/other');
  });

  it('says which checkout is left and why when one would not archive, and stays open', async () => {
    const onClose = vi.fn();
    render(<ArchiveProjectDialog project={project} onClose={onClose} />);
    await flush();
    mocks.update.mockRejectedValueOnce({ response: { status: 409, data: {
      code: 'user_project_archive_incomplete',
      archive: { archived: [], failed: [{ projectId: 'c1', name: 'termag-1', status: 409, error: 'A turn is still running' }], boxes: [] },
    } } });
    await press(buttonNamed('Archive'));
    await flush();
    expect(document.body.textContent).toContain("termag-1 didn't archive: A turn is still running");
    expect(document.body.textContent).toContain('termag stays live.');
    expect(onClose).not.toHaveBeenCalled();
    await press(buttonNamed('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('offers Archive again when the project was busy after its checkouts archived (503)', async () => {
    const onClose = vi.fn();
    render(<ArchiveProjectDialog project={project} onClose={onClose} />);
    await flush();
    mocks.update.mockRejectedValueOnce({ response: { status: 503, data: {
      code: 'user_projects_unavailable', error: 'Its sessions are archived, but the project is busy; archive it again to finish',
      archive: { archived: [{ projectId: 'c1', name: 'termag-1' }], failed: [], boxes: [] },
    } } });
    await press(buttonNamed('Archive'));
    await flush();
    expect(document.body.textContent).toContain('archive it again to finish');
    // A retry that fails without a report keeps Archive again on offer, and while it runs nothing can close the dialog.
    let fail: (e: unknown) => void = () => {};
    mocks.update.mockImplementationOnce(() => new Promise((_r, reject) => { fail = reject; }));
    await press(buttonNamed('Archive again'));
    expect(buttonNamed('Archiving…')).toBeTruthy();
    const close = buttonNamed('Close');
    expect(close.disabled || close.getAttribute('aria-disabled') === 'true' || close.hasAttribute('data-disabled')).toBe(true);
    await act(async () => { fail({ response: { status: 500, data: { error: 'Failed to change the project' } } }); });
    await flush();
    expect(buttonNamed('Archive again')).toBeTruthy();
    expect(document.body.textContent).toContain('Failed to change the project');
    await press(buttonNamed('Archive again'));
    await flush();
    expect(mocks.update).toHaveBeenCalledTimes(3);
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps a box that wouldn't stop on offer from Archived, as a session's archive does, and says so", async () => {
    mocks.archivePlan.mockResolvedValueOnce({
      id: 'up-1', name: 'termag', archived: false, sessions: 1, boxes: [{ boxId: 'a', boxName: 'box-a', fate: 'stops', why: 'nothing-else' }],
      checkouts: [{ projectId: 'c1', name: 'termag-1', kind: 'chat', sessions: 1, boxName: 'box-a' }],
    });
    mocks.update.mockResolvedValueOnce({ id: 'up-1', name: 'termag', archive: {
      archived: [{ projectId: 'c1', name: 'termag-1' }], failed: [], boxes: [{ boxId: 'a', boxName: 'box-a', action: 'stop', error: 'EC2 said no' }],
    } });
    const onClose = vi.fn();
    render(<ArchiveProjectDialog project={project} onClose={onClose} />);
    await flush();
    await press(buttonNamed('Archive'));
    await flush();
    expect(document.body.textContent).toContain('box-a is still running: EC2 said no');
    expect(readRunningBox('c1')).toMatchObject({ projectId: 'c1', instanceId: 'a', retry: 'stop' });
    expect(onClose).not.toHaveBeenCalled();
    clearRunningBox('c1');
  });

  it("says so when it can't read the plan, and won't archive blind", async () => {
    mocks.archivePlan.mockRejectedValueOnce({ response: { status: 500, data: { error: 'Failed to read what archiving would do' } } });
    render(<ArchiveProjectDialog project={project} onClose={() => {}} />);
    await flush();
    expect(document.body.textContent).toContain('Failed to read what archiving would do');
    expect(buttonNamed('Archive').disabled || buttonNamed('Archive').getAttribute('aria-disabled') === 'true' || buttonNamed('Archive').hasAttribute('data-disabled')).toBe(true);
  });
});
