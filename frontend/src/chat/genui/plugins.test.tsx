// @vitest-environment jsdom
// A component in its own file (components/) reaches the catalog, the prompt,
// the registry and the action allowlist with no other edit. Stood in for
// here by a mocked components/ index, so the test holds whatever the
// directory holds.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
vi.mock('./components', async () => {
  const { useContext } = await import('react');
  const { ChoicePressContext } = await import('./kit');
  const Echo = ({ props, emit }: { props: { word: string }; emit: (e: string) => void }) => {
    const press = useContext(ChoicePressContext);
    return <button type="button" onClick={() => { if (press) press.current = { action: 'picked', label: props.word, destructive: false }; emit('pick'); }}>{props.word}</button>;
  };
  return {
    // A real component file imports this from the index this mock replaces
    // (the "has a name" test below loads them), so the mock carries it too.
    defineGenUiComponent: (def: unknown) => def,
    GEN_UI_PLUGINS: [{
      name: 'Echo', props: z.object({ word: z.string().max(10) }), description: 'Says one word.',
      events: ['pick'], sends: 'pick', carriesChoice: true, Component: Echo,
    }],
  };
});

const { genUiCatalog, GEN_UI_COMPONENTS, propsSchema } = await import('./catalog');
const { readSpec } = await import('./spec');
const { armBindings, CHOICE_CARRIERS } = await import('./bindings');
const { genUiSystemPrompt } = await import('./prompt');
const { default: GenUiSurface } = await import('./GenUiSurface');
const { parseActionMessage } = await import('./action');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const spec = (word: string) => JSON.stringify({ root: 'e', elements: { e: { type: 'Echo', props: { word }, children: [], on: { pick: { action: 'choose' } } } } });

describe('a component in components/', () => {
  it('has a name no other component has', async () => {
    const { pluginsOf } = await vi.importActual<typeof import('./components')>('./components');
    const def = (name: string) => ({ name, props: z.object({}), description: name, Component: () => null });
    expect(pluginsOf({ './B.tsx': def('B'), './A.tsx': def('A') }).map(c => c.name)).toEqual(['A', 'B']);
    expect(() => pluginsOf({ './A.tsx': def('A'), './Again.tsx': def('A') })).toThrow('genui: component A is defined twice');
    // And none a built-in one has (catalog.ts), which the mocked Echo here does not.
    expect(GEN_UI_COMPONENTS.filter(n => n === 'Echo')).toHaveLength(1);
  });

  it("joins the catalog, the prompt and the spec reader's allowlist", () => {
    expect(GEN_UI_COMPONENTS).toContain('Echo');
    expect(GEN_UI_COMPONENTS).toContain('Table');
    expect(propsSchema('Echo')).not.toBeNull();
    expect(Object.keys(genUiCatalog.data.components)).toContain('Echo');
    expect(genUiSystemPrompt()).toContain('- Echo: ');
    expect(readSpec(spec('hi'), false).ok).toBe(true);
  });

  it('may send from the event it names, carrying its pressed choice', async () => {
    expect(CHOICE_CARRIERS.has('Echo')).toBe(true);
    const read = readSpec(spec('hi'), false);
    if (!read.ok) throw new Error(read.reason);
    expect(armBindings(read.spec, 'n').elements.e.on).toMatchObject({ pick: { action: 'choose' } });
    const sends: string[] = [];
    const block = { type: 'code' as const, lang: 'spec', text: spec('hi'), open: false };
    act(() => root.render(<GenUiSurface block={block} itemKey="r" streaming={false} chat={{ send: async t => { sends.push(t); return true; }, sent: new Map(), ready: true }} fallback={null} />));
    await act(async () => { (host.querySelector('button') as HTMLButtonElement).click(); });
    expect(parseActionMessage(sends[0])).toMatchObject({ action: 'choose', value: 'picked', label: 'hi', sourceComponentId: 'e' });
  });

  it('is held to its own props schema on every render', () => {
    const block = { type: 'code' as const, lang: 'spec', text: spec('far too many letters'), open: false };
    act(() => root.render(<GenUiSurface block={block} itemKey="r" streaming={false} chat={null} fallback={null} />));
    expect(host.querySelector('.genui-bad')?.textContent).toMatch(/^Echo could not be drawn \(word:/);
  });
});
