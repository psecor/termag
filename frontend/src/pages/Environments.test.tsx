// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The full UI's Environments section, plain controls
// on the same API as the simple UI's: list (personal first, then shared),
// create (personal unless shared is chosen), edit, delete, history, and the
// owner's switch between personal and shared.

const mocks = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), resolved: vi.fn(), events: vi.fn(), validate: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), setVisibility: vi.fn(),
}));
vi.mock('../services/api', () => ({ environmentsApi: mocks }));
// Signed in as Pat (u1), who owns full-stack.
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));

const { default: Environments } = await import('./Environments');
const { setFlagValues } = await import('../flags');

const PAT = { id: 'u1', email: 'pat@example.com', name: 'Pat' };
const FULL_STACK = {
  id: 'e1', name: 'full-stack', visibility: 'personal', owner: PAT, createdAt: '2026-10-29T10:00:00.000Z', updatedAt: '2026-10-29T10:00:00.000Z', createdBy: PAT, updatedBy: PAT,
  kind: 'pointer', file: { repo: 'example-org/webapp', branch: null, path: '.termag/environment.json' },
};

let root: Root;
let container: HTMLDivElement;
let where = '';
function Where() { const l = useLocation(); where = `${l.pathname}${l.search}`; return null; }

async function flush() { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); }
async function show(path: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <Routes>
          <Route path="/environments" element={<Environments />} />
          <Route path="/environments/:id" element={<Environments />} />
          <Route path="/environments/:id/history" element={<Environments history />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await flush();
}
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text) as HTMLButtonElement;
async function click(el: Element) { await act(async () => { (el as HTMLElement).click(); }); await flush(); }
async function type(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.list.mockResolvedValue([FULL_STACK]);
  mocks.get.mockResolvedValue(FULL_STACK);
  mocks.resolved.mockResolvedValue({ repos: [{ repo: 'example-org/webapp' }], size: null, warnings: ["full-stack's file, example-org/webapp:.termag/environment.json, is not there, so it was left out"] });
  mocks.validate.mockResolvedValue([]);
  mocks.events.mockResolvedValue([{ id: 'ev1', at: FULL_STACK.createdAt, action: 'environment.create', actor: PAT, environmentId: 'e1', environmentName: 'full-stack', before: null, after: FULL_STACK }]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); setFlagValues({}); });

describe('Environments (full UI) behind environment-selection-enabled', () => {
  it('sends every Environments route to the workspace while the flag is off, reading nothing', async () => {
    setFlagValues({ 'environment-selection-enabled': false });
    for (const path of ['/environments', '/environments/e1', '/environments/e1/history']) {
      await show(path);
      expect(where).toBe('/');
    }
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('shows the page while it is on', async () => {
    setFlagValues({ 'environment-selection-enabled': true });
    await show('/environments');
    expect(where).toBe('/environments');
    expect(container.querySelector('a.auto-row')).not.toBeNull();
  });
});

describe('Environments (full UI)', () => {
  it("lists every environment and links each to its page, on the Automations page's classes", async () => {
    await show('/environments');
    const row = container.querySelector('a.auto-row')!;
    expect(row.getAttribute('href')).toBe('/environments/e1');
    expect(row.textContent).toContain('example-org/webapp : default branch : .termag/environment.json');
    expect(container.querySelector('a[href="/environments/audit"]')).toBeNull();
  });

  it('checks the JSON on blur, not while typing, and creates the environment', async () => {
    mocks.create.mockResolvedValue({ ...FULL_STACK, id: 'e2' });
    await show('/environments/new');
    await type('#env-name', 'web');
    await type('#env-definition', '{ nope');
    expect(container.textContent).not.toMatch(/Not valid JSON/);
    expect(button('Create environment').disabled).toBe(false);
    await act(async () => { container.querySelector<HTMLTextAreaElement>('#env-definition')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    await flush();
    expect(container.textContent).toMatch(/Not valid JSON/);
    await type('#env-definition', '{"repos":["acme/web"]}');
    expect(container.textContent).not.toMatch(/Not valid JSON/);
    await click(button('Create environment'));
    expect(mocks.create).toHaveBeenCalledWith({ name: 'web', kind: 'inline', definition: '{"repos":["acme/web"]}' }, 'personal');
    expect(where).toBe('/environments/e2');
  });

  it('shows the pointer, what it resolves to with its warning, and edits with the version it was made from', async () => {
    mocks.update.mockResolvedValue(FULL_STACK);
    await show('/environments/e1');
    expect(container.textContent).toContain('is not there');
    expect(container.querySelector('.auto-table')).toBeNull();
    expect(container.textContent).toContain('termag project create <box>/<name> --agent claude --environment full-stack');
    await click(button('Edit'));
    await type('#env-file-branch', 'main');
    await click(button('Save'));
    expect(mocks.update).toHaveBeenCalledWith('e1', { name: 'full-stack', kind: 'pointer', file: { repo: 'example-org/webapp', branch: 'main', path: '.termag/environment.json' } }, FULL_STACK.updatedAt);
  });

  it("links to that environment's own history, and shows only its events", async () => {
    await show('/environments/e1');
    expect(container.querySelector('a[href="/environments/e1/history"]')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await show('/environments/e1/history');
    expect(mocks.events).toHaveBeenCalledWith('e1');
    expect(container.querySelector('.auto-table tbody')?.textContent).toContain('Created');
  });

  it('takes one click while the definition is checked: Create and Save are off until the write is done', async () => {
    let checked: (errors: string[]) => void = () => {};
    mocks.validate.mockImplementation(() => new Promise<string[]>(r => { checked = r; }));
    mocks.create.mockResolvedValue({ ...FULL_STACK, id: 'e2' });
    await show('/environments/new');
    await type('#env-name', 'web');
    await type('#env-definition', '{"repos":["acme/web"]}');
    const create = button('Create environment');
    await click(create);
    expect(create.disabled).toBe(true);
    await click(create);
    await act(async () => { checked([]); });
    await flush();
    expect(mocks.create).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    root = createRoot(container);
    const inline = { ...FULL_STACK, kind: 'inline', file: undefined, definition: { repos: ['acme/web'] } };
    mocks.get.mockResolvedValue(inline);
    mocks.update.mockResolvedValue(inline);
    await show('/environments/e1');
    await click(button('Edit'));
    await type('#env-name', 'stack');
    const save = button('Save');
    await click(save);
    expect(save.disabled).toBe(true);
    await click(save);
    await act(async () => { checked([]); });
    await flush();
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it('lists the personal ones first, then the shared ones', async () => {
    const SAM = { id: 'u2', email: 'sam@example.com', name: 'Sam' };
    mocks.list.mockResolvedValue([{ ...FULL_STACK, id: 'e2', name: 'ours', visibility: 'shared', owner: SAM }, FULL_STACK]);
    await show('/environments');
    expect([...container.querySelectorAll('section[aria-label]')].map(g => [g.getAttribute('aria-label'), g.querySelector('.auto-name')?.textContent]))
      .toEqual([['Personal', 'full-stack'], ['Shared', 'ours']]);
  });

  it('says the rule for sharing an inline environment on New environment, and sends nothing', async () => {
    await show('/environments/new');
    expect(container.querySelector<HTMLInputElement>('input[name="env-visibility"]')!.checked).toBe(true);
    await type('#env-name', 'web');
    await click(container.querySelectorAll<HTMLInputElement>('input[name="env-visibility"]')[1]);
    expect(container.textContent).toContain('not inline JSON');
    await click(button('Create environment'));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("lets its owner share it and make it personal again, showing the server's refusal", async () => {
    mocks.setVisibility.mockRejectedValueOnce({ response: { data: { error: "a shared environment runs from a file on example-org/webapp's default branch; point it at .termag/environment.json on main" } } });
    await show('/environments/e1');
    await click(button('Share with everyone'));
    expect(mocks.setVisibility).toHaveBeenCalledWith('e1', 'shared', FULL_STACK.updatedAt);
    expect([...container.querySelectorAll('.error-text')].map(e => e.textContent).join(' ')).toContain('point it at .termag/environment.json on main');
    mocks.setVisibility.mockResolvedValueOnce({ ...FULL_STACK, visibility: 'shared' });
    await click(button('Share with everyone'));
    expect(container.textContent).toContain('shared, yours');
    expect(button('Make personal')).toBeTruthy();
  });

  it("offers no switch on someone else's shared environment", async () => {
    mocks.get.mockResolvedValue({ ...FULL_STACK, visibility: 'shared', owner: { id: 'u2', email: 'sam@example.com', name: 'Sam' } });
    await show('/environments/e1');
    expect(container.textContent).toContain("shared, Sam's");
    expect(button('Make personal')).toBeUndefined();
  });

  it('deletes after a confirm', async () => {
    mocks.remove.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await show('/environments/e1');
    await click(button('Delete'));
    expect(confirm).toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith('e1', FULL_STACK.updatedAt);
    expect(where).toBe('/environments');
  });
});
