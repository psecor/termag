// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// React Aria's Popover reads a CSP nonce through CSS.escape, which jsdom lacks.
const css = globalThis as { CSS?: { escape?: (s: string) => string } };
css.CSS ??= {};
css.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
const { default: GenUiSurface } = await import('../GenUiSurface');
const { parseActionMessage } = await import('../action');
const { default: ActionMenu } = await import('./ActionMenu');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const items = [
  { id: 'rerun', label: 'Re-run checks' },
  { id: 'close', label: 'Close the PR', variant: 'destructive' },
];
const spec = (on: object | undefined) => JSON.stringify({
  root: 'm', elements: { m: { type: 'ActionMenu', props: { label: 'PR actions', items }, children: [], ...(on ? { on } : {}) } },
});

async function draw(on?: object) {
  const sends: string[] = [];
  const block = { type: 'code' as const, lang: 'spec', text: spec(on), open: false };
  await act(async () => root.render(<GenUiSurface block={block} itemKey="r" streaming={false} chat={{ send: async t => { sends.push(t); return true; }, sent: new Map(), ready: true }} fallback={null} />));
  return sends;
}
async function choose(label: string) {
  await act(async () => { (host.querySelector('.genui-action-menu-button') as HTMLButtonElement).click(); });
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent === label) as HTMLElement;
  await act(async () => { item.click(); });
}

describe('ActionMenu', () => {
  it('needs distinct item ids', () => {
    expect(ActionMenu.props.safeParse({ label: 'x', items }).success).toBe(true);
    expect(ActionMenu.props.safeParse({ label: 'x', items: [items[0], items[0]] }).success).toBe(false);
  });

  it('sends the chosen item as the answer, whatever the binding says', async () => {
    const sends = await draw({ select: { action: 'choose', params: { value: 'something else' } } });
    await choose('Re-run checks');
    expect(sends).toHaveLength(1);
    expect(parseActionMessage(sends[0])).toMatchObject({ action: 'choose', value: 'rerun', label: 'Re-run checks', sourceComponentId: 'm' });
  });

  it('asks before sending a destructive item', async () => {
    const sends = await draw({ select: { action: 'choose' } });
    await choose('Close the PR');
    expect(sends).toHaveLength(0);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Close the PR');
  });

  it('sends nothing when select is bound to nothing', async () => {
    const sends = await draw();
    await choose('Re-run checks');
    expect(sends).toHaveLength(0);
  });
});
