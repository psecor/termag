import { describe, expect, it } from 'vitest';
import { readSpec, REPEAT_MAX_ITEMS, SPEC_MAX_CHARS, SPEC_MAX_DEPTH, SPEC_MAX_RENDERED } from './spec';

const line = (op: object) => JSON.stringify(op);
const root = (key = 'main') => line({ op: 'add', path: '/root', value: key });
const el = (key: string, value: object) => line({ op: 'add', path: `/elements/${key}`, value });
const card = (children: string[] = []) => ({ type: 'Card', props: { title: 'Hi' }, children });
const text = (t = 'hello') => ({ type: 'Text', props: { text: t }, children: [] });

describe('readSpec', () => {
  it('reads json-render JSONL patches into a spec, state included', () => {
    const body = [root(), el('main', card(['t'])), el('t', text()), line({ op: 'add', path: '/state/count', value: 2 })].join('\n');
    const read = readSpec(body, false);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.spec.root).toBe('main');
    expect(Object.keys(read.spec.elements)).toEqual(['main', 't']);
    expect(read.spec.state).toEqual({ count: 2 });
  });

  it('reads one JSON object, pretty-printed or not', () => {
    const spec = { root: 'main', elements: { main: card(['t']), t: text() } };
    expect(readSpec(JSON.stringify(spec), false).ok).toBe(true);
    expect(readSpec(JSON.stringify(spec, null, 2), false).ok).toBe(true);
  });

  it('while streaming, leaves a half-written last line and children not yet sent', () => {
    const body = [root(), el('main', card(['t', 'later'])), el('t', text()), '{"op":"add","path":"/elements/la'].join('\n');
    const read = readSpec(body, true);
    expect(read.ok).toBe(true);
    // Once the fence has closed, the broken last line and the child it never sent are left out, and said.
    const closed = readSpec(body, false);
    expect(closed).toMatchObject({ ok: true, notes: ['line 4 is not JSON', 'element "later" never arrived'] });
    if (closed.ok) expect(closed.spec.elements.main.children).toEqual(['t']);
  });

  it('draws the rest when a line is not JSON, and says which', () => {
    const body = ['Here is the form:', root(), el('main', card(['t'])), '// the text', el('t', text()), '{"op": nope}'].join('\n');
    const read = readSpec(body, false);
    expect(read).toMatchObject({ ok: true, notes: ['line 1 is not JSON', 'line 4 is not JSON', 'line 6 is not JSON'] });
    if (read.ok) expect(Object.keys(read.spec.elements)).toEqual(['main', 't']);
  });

  it('reads a patch pretty-printed over several lines, and leaves out one that is broken whole', () => {
    const pretty = JSON.stringify({ op: 'add', path: '/elements/t', value: text('a "{" in a string') }, null, 2);
    const read = readSpec([root(), el('main', card(['t'])), pretty].join('\n'), false);
    expect(read).toMatchObject({ ok: true, notes: [] });
    if (read.ok) expect(read.spec.elements.t.props).toEqual({ text: 'a "{" in a string' });
    const broken = readSpec([root(), el('main', card(['t'])), '{', '  "op": "add",', '  "path": nope', '}', el('t', text())].join('\n'), false);
    expect(broken).toMatchObject({ ok: true, notes: ['lines 3–6 are not JSON'] });
    // Still streaming, a pretty-printed patch not yet closed waits for the rest.
    expect(readSpec([root(), el('main', card(['t'])), pretty.split('\n').slice(0, 4).join('\n')].join('\n'), true)).toMatchObject({ ok: true, notes: [] });
  });

  it('is not a spec when no line is', () => {
    expect(readSpec('not a spec\nat all', false)).toEqual({ ok: false, waiting: false, reason: 'line 1 is not JSON' });
    expect(readSpec('not a spec\nat all', true)).toMatchObject({ ok: false, waiting: true });
  });

  it('waits while there is nothing to draw yet, and gives up on that once closed', () => {
    expect(readSpec('', true)).toMatchObject({ ok: false, waiting: true });
    expect(readSpec('{"op":"add","pa', true)).toMatchObject({ ok: false, waiting: true });
    expect(readSpec(root(), true)).toMatchObject({ ok: false, waiting: true });
    expect(readSpec(root(), false)).toMatchObject({ ok: false, waiting: false });
  });

  it('leaves out a child that never arrived, once the fence has closed', () => {
    const read = readSpec([root(), el('main', card(['gone', 't', 'lost'])), el('t', text())].join('\n'), false);
    expect(read).toMatchObject({ ok: true, notes: ['elements "gone", "lost" never arrived'] });
    if (read.ok) expect(read.spec.elements.main.children).toEqual(['t']);
  });

  it('never draws a type outside the catalog: such an element is left out, and such a root is no spec', () => {
    const iframe = { type: 'Iframe', props: { src: 'https://example.com' }, children: [] };
    const child = readSpec([root(), el('main', card(['f', 't'])), el('f', iframe), el('t', text())].join('\n'), false);
    expect(child).toMatchObject({ ok: true, notes: ['"f" has unknown type "Iframe"'] });
    if (child.ok) {
      expect(child.spec.elements.f).toBeUndefined();
      expect(child.spec.elements.main.children).toEqual(['t']);
    }
    // Mid-stream too.
    expect(readSpec([root(), el('main', iframe)].join('\n'), true)).toEqual({ ok: false, waiting: false, reason: '"main" has unknown type "Iframe"' });
  });

  it('leaves out an element whose shape is wrong, a Link built from state among them', () => {
    const link = { type: 'Link', props: { label: 'Go', href: { $template: 'https://example.com/?q=${/q}' } }, children: [] };
    const read = readSpec([root(), el('main', card(['l', 'p'])), el('l', link), el('p', { type: 'Text', props: 'hi', children: [] })].join('\n'), false);
    expect(read).toMatchObject({ ok: true });
    if (!read.ok) return;
    expect(read.notes).toEqual(['"l" Link href must be a fixed URL', '"p" props is not an object']);
    expect(Object.keys(read.spec.elements)).toEqual(['main']);
  });

  it('refuses a tree that contains itself, which would never stop rendering', () => {
    const read = readSpec([root(), el('main', card(['inner'])), el('inner', card(['main']))].join('\n'), false);
    expect(read).toMatchObject({ ok: false, reason: '"main" contains itself' });
  });

  it(`refuses nesting deeper than ${SPEC_MAX_DEPTH}`, () => {
    const lines = [root('c0')];
    for (let i = 0; i <= SPEC_MAX_DEPTH + 1; i++) lines.push(el(`c${i}`, card(i <= SPEC_MAX_DEPTH ? [`c${i + 1}`] : [])));
    expect(readSpec(lines.join('\n'), false)).toMatchObject({ ok: false, reason: `nested more than ${SPEC_MAX_DEPTH} deep` });
  });

  it('counts a shared child each time it is drawn, so a few shared levels cannot draw millions', () => {
    // 21 elements, each level's two children the same element: 2^20 drawn.
    const lines = [root('l0')];
    for (let i = 0; i < 20; i++) lines.push(el(`l${i}`, { type: 'Stack', props: {}, children: [`l${i + 1}`, `l${i + 1}`] }));
    lines.push(el('l20', text()));
    expect(readSpec(lines.join('\n'), false)).toMatchObject({ ok: false, reason: `would draw more than ${SPEC_MAX_RENDERED} elements` });
    // A child shared a few times is fine.
    expect(readSpec([root(), el('main', card(['t', 't', 't'])), el('t', text())].join('\n'), false).ok).toBe(true);
  });

  it('refuses a repeat inside a repeat, and a repeated list over the item limit', () => {
    const list = (n: number) => line({ op: 'add', path: '/state/items', value: Array.from({ length: n }, (_, i) => ({ id: String(i) })) });
    const repeated = (inner: object) => [root('outer'),
      el('outer', { type: 'Stack', props: {}, repeat: { statePath: '/items', key: 'id' }, children: ['inner'] }),
      el('inner', inner), el('t', text())];
    expect(readSpec([...repeated({ type: 'Stack', props: {}, repeat: { statePath: '/items' }, children: ['t'] }), list(3)].join('\n'), false))
      .toMatchObject({ ok: false, reason: '"inner" repeats inside another repeat' });
    expect(readSpec([...repeated(text()), list(REPEAT_MAX_ITEMS + 1)].join('\n'), false))
      .toMatchObject({ ok: false, reason: `"outer" repeats over more than ${REPEAT_MAX_ITEMS} items` });
    expect(readSpec([...repeated(text()), list(REPEAT_MAX_ITEMS)].join('\n'), false).ok).toBe(true);
  });

  it('budgets a repeat as if its list were as long as it may get, since a press can set a longer one', () => {
    // A repeated subtree of 21 elements would draw 2100 at the item limit, whatever the list holds now.
    const kids = Array.from({ length: 20 }, (_, i) => `k${i}`);
    const lines = [root('outer'),
      el('outer', { type: 'Stack', props: {}, repeat: { statePath: '/items' }, children: ['row'] }),
      el('row', { type: 'Stack', props: {}, children: kids }),
      ...kids.map(k => el(k, text())),
      line({ op: 'add', path: '/state/items', value: [{ id: 'a' }] })];
    expect(readSpec(lines.join('\n'), false)).toMatchObject({ ok: false, reason: `would draw more than ${SPEC_MAX_RENDERED} elements (a repeat counts as ${REPEAT_MAX_ITEMS} items)` });
  });

  it('drops watchers, which could feed themselves, and tells each repeat its list\'s path', () => {
    const read = readSpec([root(),
      el('main', { type: 'Stack', props: { __repeat: '/spoofed' }, repeat: { statePath: '/items' }, children: ['t'], watch: { '/items': { action: 'pushState', params: { statePath: '/items', value: 1 } } } }),
      el('t', { type: 'Text', props: { text: 'x', __repeat: '/also' }, children: [] }),
      line({ op: 'add', path: '/state/items', value: [] })].join('\n'), false);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.spec.elements.main).not.toHaveProperty('watch');
    expect(read.spec.elements.main.props).toEqual({ __repeat: '/items' });
    expect(read.spec.elements.t.props).toEqual({ text: 'x' });
  });

  it('refuses a Link whose href is built from state rather than written in the spec', () => {
    const link = (href: unknown) => [root(), el('main', { type: 'Link', props: { text: 'Open', href }, children: [] })].join('\n');
    expect(readSpec(link('https://example.com/docs'), false).ok).toBe(true);
    expect(readSpec(link({ $template: 'https://example.com/c?t=${/token}' }), false)).toMatchObject({ ok: false, reason: '"main" Link href must be a fixed URL' });
    expect(readSpec(link({ $state: '/url' }), false)).toMatchObject({ ok: false, reason: '"main" Link href must be a fixed URL' });
  });

  it('refuses a fence longer than the limit', () => {
    const big = [root(), el('main', text('x'.repeat(SPEC_MAX_CHARS)))].join('\n');
    expect(readSpec(big, false)).toMatchObject({ ok: false, reason: 'longer than 64 KB' });
  });

  it('refuses patch paths that name an object prototype, and lines that are not patches', () => {
    expect(readSpec([root(), line({ op: 'add', path: '/state/__proto__/polluted', value: true })].join('\n'), false))
      .toMatchObject({ ok: false, reason: 'line 2: path not allowed' });
    expect(readSpec([root(), line({ op: 'add', path: '/elements/constructor', value: text() })].join('\n'), false))
      .toMatchObject({ ok: false, reason: 'line 2: path not allowed' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // A pretty-printed one too.
    const pretty = JSON.stringify({ op: 'add', path: '/state/__proto__/polluted', value: true }, null, 2);
    expect(readSpec([root(), pretty].join('\n'), false)).toMatchObject({ ok: false, reason: 'lines 2–6: path not allowed' });
    // A line that is JSON but not a patch is left out.
    const read = readSpec([root(), line({ hello: 'world' }), line({ op: 'splice', path: '/x' }), el('main', text())].join('\n'), false);
    expect(read).toMatchObject({ ok: true, notes: ['line 2 is not a JSON patch', 'line 3: unknown op "splice"'] });
  });

  it('refuses prototype keys in a whole-object spec, and inside patch values', () => {
    // As JSON text, "__proto__" is an own key; assigned into the elements map it would set its prototype.
    const whole = `{"root":"main","elements":{"main":${JSON.stringify(card(['gone']))},"__proto__":{"gone":${JSON.stringify(text())}}}}`;
    expect(readSpec(whole, false)).toMatchObject({ ok: false, reason: 'key "__proto__" not allowed' });
    const inValue = [root(), `{"op":"add","path":"/elements/main","value":{"type":"Text","props":{"text":"x","__proto__":{"y":1}},"children":[]}}`].join('\n');
    expect(readSpec(inValue, false)).toMatchObject({ ok: false, reason: 'key "__proto__" not allowed' });
    expect(readSpec(JSON.stringify({ root: 'main', elements: { main: text() }, state: { constructor: 1 } }), false))
      .toMatchObject({ ok: false, reason: 'key "constructor" not allowed' });
  });

  it('moves visible and on out of props, as json-render\'s lossless fixes do', () => {
    const body = [root(), el('main', { type: 'Button', props: { label: 'Go', on: { press: { action: 'setState', params: { statePath: '/x', value: 1 } } } }, children: [] })].join('\n');
    const read = readSpec(body, false);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.spec.elements.main.props).toEqual({ label: 'Go' });
    expect(read.spec.elements.main.on).toEqual({ press: { action: 'setState', params: { statePath: '/x', value: 1 } } });
  });

  it('gives an element without props or children empty ones', () => {
    const read = readSpec([root(), el('main', { type: 'Separator' })].join('\n'), false);
    expect(read.ok && read.spec.elements.main).toMatchObject({ props: {}, children: [] });
  });
});
