import type { Spec } from '@json-render/core';
import { describe, expect, it } from 'vitest';
import { ARMED, armBindings, armedOf } from './bindings';

const spec = (elements: Record<string, object>): Spec => ({ root: Object.keys(elements)[0], elements: elements as Spec['elements'] });
const el = (type: string, extra: object = {}) => ({ type, props: {}, children: [], ...extra });

describe('armBindings', () => {
  it('stamps a catalog action on a Button press or a Form submit with the nonce, the element and its label', () => {
    const out = armBindings(spec({
      go: el('Button', { props: { label: 'Start' }, on: { press: { action: 'submit' } } }),
      form: el('Form', { children: ['row'], on: { submit: { action: 'choose', params: { value: 'a' } } } }),
      row: el('ButtonGroup', { children: ['save'] }),
      save: el('Button', { props: { label: 'Save', type: 'submit' } }),
    }), 'n1');
    expect(out.elements.go.on).toEqual({ press: { action: 'submit', params: { [ARMED]: { nonce: 'n1', source: 'go', label: 'Start', confirm: false } } } });
    // A Form's submit is named by its submit button.
    expect(out.elements.form.on).toEqual({ submit: { action: 'choose', params: { value: 'a', [ARMED]: { nonce: 'n1', source: 'form', label: 'Save', confirm: false } } } });
  });

  it('asks termag to confirm a destructive button, or one whose binding asked, and drops the spec\'s own confirm and chains', () => {
    const out = armBindings(spec({
      del: el('Button', { props: { label: 'Delete', variant: 'destructive' }, on: { press: { action: 'approve', onSuccess: { action: 'setState' } } } }),
      ask: el('Button', { props: { label: 'Go' }, on: { press: { action: 'cancel', confirm: { title: 'Sure?', message: 'x' } } } }),
    }), 'n');
    expect(out.elements.del.on).toEqual({ press: { action: 'approve', params: { [ARMED]: { nonce: 'n', source: 'del', label: 'Delete', confirm: true } } } });
    expect((out.elements.ask.on as Record<string, { params: Record<string, { confirm: boolean }> }>).press.params[ARMED].confirm).toBe(true);
    expect(JSON.stringify(out)).not.toContain('Sure?');
  });

  it('keeps a catalog action on a Table\'s rowAction, whose row decides the confirm', () => {
    const out = armBindings(spec({ t: el('Table', { on: { rowAction: { action: 'choose' }, press: { action: 'choose' } } }) }), 'n');
    expect(out.elements.t.on).toEqual({ rowAction: { action: 'choose', params: { [ARMED]: { nonce: 'n', source: 't', confirm: false } } } });
  });

  it('confirms a Form\'s submit when its submit button is destructive', () => {
    const out = armBindings(spec({
      form: el('Form', { children: ['wipe'], on: { submit: { action: 'submit' } } }),
      wipe: el('Button', { props: { label: 'Wipe the box', type: 'submit', variant: 'destructive' } }),
    }), 'n');
    expect(out.elements.form.on).toEqual({ submit: { action: 'submit', params: { [ARMED]: { nonce: 'n', source: 'form', label: 'Wipe the box', confirm: true } } } });
  });

  it('keeps local actions, drops everything else, and never lets a catalog action fire from another event or a watch', () => {
    const out = armBindings(spec({
      sw: el('Switch', {
        on: { change: [{ action: 'setState', params: { statePath: '/x', value: 1 }, confirm: { title: 't' } }, { action: 'submit' }, { action: 'push', params: { screen: 'x' } }] },
        watch: { '/x': [{ action: 'submit' }, { action: 'setState', params: { statePath: '/y', value: 2 } }], '/z': { action: 'approve' } },
      }),
      sel: el('Select', { on: { change: { action: 'choose', params: { value: 'a' } } } }),
    }), 'n');
    expect(out.elements.sw.on).toEqual({ change: [{ action: 'setState', params: { statePath: '/x', value: 1 } }] });
    expect(out.elements.sw.watch).toEqual({ '/x': [{ action: 'setState', params: { statePath: '/y', value: 2 } }] });
    expect(out.elements.sel.on).toBeUndefined();
  });

  it('overwrites a stamp the spec wrote itself', () => {
    const out = armBindings(spec({ go: el('Button', { props: { label: 'Go' }, on: { press: { action: 'submit', params: { [ARMED]: { nonce: 'guess', source: 'other', confirm: false } } } } }) }), 'real');
    const params = (out.elements.go.on as Record<string, { params: unknown }>).press.params;
    expect(armedOf(params, 'real')).toEqual({ nonce: 'real', source: 'go', label: 'Go', confirm: false });
  });

  it('leaves the input spec alone', () => {
    const input = spec({ go: el('Button', { on: { press: { action: 'submit' } } }) });
    const copy = JSON.parse(JSON.stringify(input));
    armBindings(input, 'n');
    expect(input).toEqual(copy);
  });
});

describe('armedOf', () => {
  it('accepts only this surface\'s nonce', () => {
    expect(armedOf({ [ARMED]: { nonce: 'a', source: 'x', confirm: false } }, 'a')).toMatchObject({ source: 'x' });
    expect(armedOf({ [ARMED]: { nonce: 'b', source: 'x', confirm: false } }, 'a')).toBeNull();
    expect(armedOf({}, 'a')).toBeNull();
    expect(armedOf(undefined, 'a')).toBeNull();
  });
});
