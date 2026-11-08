// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The simple UI's Environments section: the list
// (personal first, then shared), a new environment (personal unless the form
// says shared), and one environment's Edit, Delete, history and its owner's
// switch between personal and shared, on the API (every change and every rule
// is the server's).

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  resolved: vi.fn(),
  events: vi.fn(),
  validate: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  setVisibility: vi.fn(),
}));
vi.mock('../../services/api', () => ({ environmentsApi: mocks }));
// Signed in as Pat (u1), who owns full-stack.
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('./chatChrome', () => ({
  ChatHistoryButton: () => null,
  // The ⋮ menu as plain buttons, one per action.
  ChatMoreButton: ({ actions }: { actions: Array<{ label: string; onSelect: () => void; disabled?: boolean }> }) => (
    <div data-testid="more">{actions.map(a => <button key={a.label} type="button" disabled={a.disabled} onClick={a.onSelect}>{a.label}</button>)}</div>
  ),
}));
vi.mock('../../launchpad/sprite', () => ({ ensureLaunchPadSprite: async () => {} }));

const { EnvironmentsPage } = await import('./EnvironmentsPage');
const { setFlagValues } = await import('../../flags');

const PAT = { id: 'u1', email: 'pat@example.com', name: 'Pat' };
const SAM = { id: 'u2', email: 'sam@example.com', name: 'Sam' };
const meta = { createdAt: '2026-10-29T10:00:00.000Z', updatedAt: '2026-10-29T11:00:00.000Z', createdBy: PAT, updatedBy: SAM };
const FULL_STACK = { ...meta, visibility: 'personal', owner: PAT, id: 'e1', name: 'full-stack', kind: 'inline', definition: { resources: 'large', repos: [{ repo: 'example-org/webapp' }, { repo: 'acme/web', path: 'frontend' }] } };
const POINTER = { ...meta, visibility: 'shared', owner: SAM, id: 'e2', name: 'from-file', kind: 'pointer', file: { repo: 'example-org/webapp', branch: 'main', path: '.termag/full-stack/environment.json' } };
const EVENTS = [
  { id: 'ev3', at: '2026-10-29T12:00:00.000Z', action: 'environment.create', actor: PAT, environmentId: 'e2', environmentName: 'from-file', before: null, after: POINTER },
  { id: 'ev2', at: '2026-10-29T11:00:00.000Z', action: 'environment.update', actor: SAM, environmentId: 'e1', environmentName: 'full-stack', before: { ...FULL_STACK, definition: { ...FULL_STACK.definition, resources: 'medium' } }, after: FULL_STACK },
  { id: 'ev1', at: '2026-10-29T10:00:00.000Z', action: 'environment.create', actor: PAT, environmentId: 'e1', environmentName: 'full-stack', before: null, after: FULL_STACK },
];

let root: Root;
let container: HTMLDivElement;
let where = '';

function Where() {
  const l = useLocation();
  where = `${l.pathname}${l.search}`;
  return null;
}

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

async function show(path: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <Routes>
          <Route path="/chat/environments" element={<EnvironmentsPage />} />
          <Route path="/chat/environments/:id" element={<EnvironmentsPage />} />
          <Route path="/chat/environments/:id/history" element={<EnvironmentsPage history />} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await flush();
}

function button(text: string): HTMLButtonElement {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent?.trim() === text);
  if (!b) throw new Error(`no button ${text}`);
  return b as HTMLButtonElement;
}

async function press(el: Element) {
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const l = [...document.querySelectorAll('label')].find(x => x.textContent === label);
  const el = l?.parentElement?.querySelector('input, textarea');
  if (!el) throw new Error(`no field ${label}`);
  return el as HTMLInputElement;
}

async function type(label: string, value: string) {
  const input = field(label);
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // React Aria's dialog escapes ids with CSS.escape, which jsdom lacks (as RepoPicker.test.tsx).
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.list.mockResolvedValue([FULL_STACK, POINTER]);
  mocks.get.mockImplementation(async (id: string) => (id === 'e2' ? POINTER : FULL_STACK));
  mocks.resolved.mockResolvedValue({ repos: [{ repo: 'example-org/webapp', branch: 'main' }, { repo: 'acme/api', path: 'api' }], size: 'large', warnings: [] });
  mocks.events.mockImplementation(async (id: string | null) => EVENTS.filter(e => !id || e.environmentId === id));
  mocks.validate.mockResolvedValue([]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setFlagValues({});
});

describe('EnvironmentsPage behind environment-selection-enabled', () => {
  it('sends every Environments route to New session while the flag is off, reading nothing', async () => {
    setFlagValues({ 'environment-selection-enabled': false });
    for (const path of ['/chat/environments', '/chat/environments/e1', '/chat/environments/e1/history']) {
      await show(path);
      expect(where).toBe('/chat');
    }
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('shows the list while it is on', async () => {
    setFlagValues({ 'environment-selection-enabled': true });
    await show('/chat/environments');
    expect(where).toBe('/chat/environments');
    expect(container.querySelectorAll('.chat-auto-item').length).toBeGreaterThan(0);
  });
});

async function blur(label: string) {
  const el = field(label);
  await act(async () => { el.focus(); el.blur(); el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  await flush();
}

describe('EnvironmentsPage', () => {
  it('lists the personal ones first, then the shared ones, each group in its own card', async () => {
    mocks.list.mockResolvedValue([POINTER, FULL_STACK]);
    await show('/chat/environments');
    const groups = [...container.querySelectorAll('[role="region"]')].map(r => [r.getAttribute('aria-label'), [...r.querySelectorAll('.chat-auto-name')].map(n => n.textContent)]);
    expect(groups).toEqual([['Personal', ['full-stack']], ['Shared', ['from-file']]]);
  });

  it('lists every environment by its form, in the automation page\'s cards', async () => {
    await show('/chat/environments');
    const rows = [...container.querySelectorAll('.chat-auto-item')].map(r => r.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Inline');
    expect(rows[1]).toContain('example-org/webapp : main : .termag/full-stack/environment.json');
    expect(container.querySelector('.chat-header')).not.toBeNull();
    expect(button('About environments')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Audit log/);
  });

  it("checks the JSON only once the editor loses focus, and clears it as soon as it's valid", async () => {
    await show('/chat/environments/new');
    await type('environment.json', '{ nope');
    expect(container.textContent).not.toMatch(/Not valid JSON/);
    expect(button('Create environment').disabled).toBe(false);
    await blur('environment.json');
    expect(container.textContent).toMatch(/Not valid JSON/);
    await type('environment.json', '{"repos":["acme/web"]}');
    expect(container.textContent).not.toMatch(/Not valid JSON/);
  });

  it("shows the schema's errors on blur and keeps them until the text is valid", async () => {
    mocks.validate.mockImplementation(async (t: string) => (t.includes('16') ? ['the definition: "resources" 16 vCPU is over the 8 vCPU limit'] : []));
    await show('/chat/environments/new');
    await type('environment.json', '{"repos":["a/b"],"resources":{"vcpu":16,"memoryGiB":32}}');
    expect(container.textContent).not.toMatch(/8 vCPU limit/);
    await blur('environment.json');
    expect(container.textContent).toMatch(/8 vCPU limit/);
    vi.useFakeTimers();
    await type('environment.json', '{"repos":["a/b"],"resources":{"vcpu":4,"memoryGiB":32}}');
    await act(async () => { vi.advanceTimersByTime(400); });
    vi.useRealTimers();
    await flush();
    expect(container.textContent).not.toMatch(/8 vCPU limit/);
  });

  it("refuses to send JSON that doesn't parse on Create, saying why, and sends nothing", async () => {
    await show('/chat/environments/new');
    await type('Name', 'x');
    await type('environment.json', '{ nope');
    await press(button('Create environment'));
    expect(container.textContent).toMatch(/Not valid JSON/);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('creates an inline environment from the JSON editor', async () => {
    mocks.create.mockResolvedValue({ ...FULL_STACK, id: 'e9' });
    await show('/chat/environments/new');
    await type('Name', 'full-stack');
    await type('environment.json', '{"repos":["acme/web"]}');
    await press(button('Create environment'));
    expect(mocks.validate).toHaveBeenCalledWith('{"repos":["acme/web"]}');
    expect(mocks.create).toHaveBeenCalledWith({ name: 'full-stack', kind: 'inline', definition: '{"repos":["acme/web"]}' }, 'personal');
    expect(where).toBe('/chat/environments/e9');
  });

  it('creates a pointer: repo, branch, path', async () => {
    mocks.create.mockResolvedValue(POINTER);
    await show('/chat/environments/new');
    await type('Name', 'from-file');
    await press([...document.querySelectorAll('label')].find(l => l.textContent?.includes('File in a repository'))!);
    await type('Repository', 'example-org/webapp');
    await type('Branch', 'main');
    await type('Path', '.termag/full-stack/environment.json');
    await press(button('Create environment'));
    expect(mocks.create).toHaveBeenCalledWith({ name: 'from-file', kind: 'pointer', file: { repo: 'example-org/webapp', branch: 'main', path: '.termag/full-stack/environment.json' } }, 'personal');
  });

  const radio = (text: string) => [...document.querySelectorAll('label')].find(l => l.textContent?.startsWith(text))!;

  it('makes a new environment personal unless shared is chosen, and says the rule for sharing an inline one, sending nothing', async () => {
    await show('/chat/environments/new');
    expect((radio('Personal').querySelector('input') as HTMLInputElement).checked).toBe(true);
    await type('Name', 'full-stack');
    await press(radio('Shared'));
    expect(container.textContent).toContain("A shared environment runs from a file on a repository's default branch, not inline JSON");
    await press(button('Create environment'));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates a shared pointer, and shows the server's refusal when its file isn't on the default branch", async () => {
    mocks.create.mockRejectedValueOnce({ response: { data: { error: "a shared environment runs from a file on example-org/webapp's default branch; point it at .termag/environment.json on main", code: 'environment_not_shareable' } } });
    await show('/chat/environments/new');
    await type('Name', 'from-file');
    await press(radio('File in a repository'));
    await type('Repository', 'example-org/webapp');
    await type('Branch', 'feature');
    await press(radio('Shared'));
    await press(button('Create environment'));
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pointer' }), 'shared');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("point it at .termag/environment.json on main");
  });

  it("lets its owner share a personal one from the menu, showing the server's rule when it can't be", async () => {
    mocks.setVisibility.mockRejectedValueOnce({ response: { data: { error: "a shared environment runs from a file on a repository's default branch, not inline JSON; point it at .termag/environment.json on its repository's default branch" } } });
    await show('/chat/environments/e1');
    expect(container.textContent).toContain('Personal, yours');
    await press(button('Share with everyone'));
    expect(mocks.setVisibility).toHaveBeenCalledWith('e1', 'shared', FULL_STACK.updatedAt);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('not inline JSON');
    mocks.setVisibility.mockResolvedValueOnce({ ...FULL_STACK, visibility: 'shared' });
    await press(button('Share with everyone'));
    expect(container.querySelector('.chat-title')?.textContent).toContain('Shared');
    expect(button('Make personal')).toBeTruthy();
  });

  it("offers no switch on someone else's shared environment", async () => {
    await show('/chat/environments/e2');
    expect(container.textContent).toContain("Shared, Sam's");
    expect([...container.querySelectorAll('[data-testid="more"] button')].map(b => b.textContent)).not.toContain('Make personal');
  });

  it("shows an environment's definition, what it resolves to and the commands that create from it, its actions in the menu", async () => {
    await show('/chat/environments/e2');
    expect(container.querySelector('.chat-title-name')?.textContent).toBe('from-file');
    expect(container.textContent).toContain('example-org/webapp : main : .termag/full-stack/environment.json');
    expect(container.textContent).toContain('acme/api (in api/)');
    expect(container.textContent).toContain('termag project create <box>/<name> --agent claude --environment from-file');
    expect(container.textContent).toContain('--new-box --environment from-file');
    expect(container.querySelector('table')).toBeNull();
    expect([...container.querySelectorAll('[data-testid="more"] button')].map(b => b.textContent)).toEqual(['Edit', 'History', 'About environments', 'Delete…']);
  });

  it("shows only that environment's history, from its menu", async () => {
    await show('/chat/environments/e1');
    await press(button('History'));
    expect(where).toBe('/chat/environments/e1/history');
    act(() => root.unmount());
    root = createRoot(container);
    await show('/chat/environments/e1/history');
    expect(mocks.events).toHaveBeenCalledWith('e1');
    const rows = [...container.querySelectorAll('.chat-auto-item')].map(r => r.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Edited');
    expect(rows[0]).toContain('Sam');
    expect(rows[0]).toContain('resources: "medium" → "large"');
    expect(rows.join(' ')).not.toContain('from-file');
    expect(container.querySelector('.chat-title-name')?.textContent).toBe('full-stack · History');
  });

  it('saves an edit with the version it was made from', async () => {
    mocks.update.mockResolvedValue(FULL_STACK);
    await show('/chat/environments/e1');
    await press(button('Edit'));
    await type('Name', 'stack');
    await press(button('Save'));
    expect(mocks.update).toHaveBeenCalledWith('e1', expect.objectContaining({ name: 'stack', kind: 'inline' }), FULL_STACK.updatedAt);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('takes one press while the definition is checked: Create and Save are off until the write is done', async () => {
    let checked: (errors: string[]) => void = () => {};
    mocks.validate.mockImplementation(() => new Promise<string[]>(r => { checked = r; }));
    mocks.create.mockResolvedValue({ ...FULL_STACK, id: 'e9' });
    await show('/chat/environments/new');
    await type('Name', 'full-stack');
    await type('environment.json', '{"repos":["acme/web"]}');
    const create = button('Create environment');
    await press(create);
    expect(create.disabled).toBe(true);
    await press(create);
    await act(async () => { checked([]); });
    await flush();
    expect(mocks.create).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    root = createRoot(container);
    mocks.update.mockResolvedValue(FULL_STACK);
    await show('/chat/environments/e1');
    await press(button('Edit'));
    await type('Name', 'stack');
    const save = button('Save');
    await press(save);
    expect(save.disabled).toBe(true);
    await press(save);
    await act(async () => { checked([]); });
    await flush();
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it('says why an edit was refused, as the server put it', async () => {
    mocks.update.mockRejectedValue({ response: { data: { error: 'Someone changed this environment since you opened it' } } });
    await show('/chat/environments/e1');
    await press(button('Edit'));
    await press(button('Save'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Someone changed this environment');
  });

  it('deletes from the menu only after the confirm, then goes back to the list', async () => {
    mocks.remove.mockResolvedValue(undefined);
    await show('/chat/environments/e1');
    await press(button('Delete…'));
    expect(mocks.remove).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll('button')].filter(b => b.textContent === 'Delete').at(-1)!;
    await press(confirm);
    expect(mocks.remove).toHaveBeenCalledWith('e1', FULL_STACK.updatedAt);
    expect(where).toBe('/chat/environments');
  });

  it('starts a session from the environment', async () => {
    await show('/chat/environments/e1');
    await press(button('New session'));
    expect(where).toBe('/chat/new?environment=full-stack');
  });
});
