// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpaceView } from '../../services/api';
import type { SpaceChoice } from '../../chat/chatSpaces';
import { spaceColor } from '../../chat/spaceColors';
import { SpacePicker } from './SpacePicker';

const spaces: SpaceView[] = [
  { id: '1', name: 'notes', description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role: 'owner', readOnly: false },
  { id: '2', name: 'theirs', description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role: 'viewer', readOnly: false },
];

let root: Root;
let host: HTMLDivElement;
let picked: SpaceChoice[];

function render(value: SpaceChoice, error = '', menuEpoch = 0) {
  act(() => root.render(
    <SpacePicker value={value} spaces={spaces} error={error} menuEpoch={menuEpoch} onChange={c => picked.push(c)} />,
  ));
}

function trigger(): HTMLButtonElement {
  return host.querySelector('.chat-compose-repo-btn') as HTMLButtonElement;
}

function open() {
  act(() => { trigger().click(); });
}

function option(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('[role="option"]')].find(o => o.textContent === text);
  if (!found) throw new Error(`missing option ${text}`);
  return found as HTMLButtonElement;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  picked = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('SpacePicker', () => {
  it('stays a compact trigger until opened, then offers no space, editable spaces, and a new one', () => {
    render({ kind: 'none' });
    const button = trigger();
    expect(button.textContent).toContain('No space');
    expect(button.className).toContain('chat-compose-repo-btn');
    expect(button.getAttribute('aria-haspopup')).toBe('listbox');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Space (optional), No space');
    expect(host.querySelector('select')).toBeNull();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(host.textContent).not.toContain('shared file store');
    open();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect([...host.querySelectorAll('[role="option"]')].map(o => o.textContent)).toEqual(['No space', 'notes', 'New space…']);
    expect(host.textContent).toContain("This session's box");
    expect(host.textContent).not.toContain("This chat's box");
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).toContain("This session's box can read and write it");
  });

  it('reports each choice and closes except when naming a new space', () => {
    render({ kind: 'none' });
    open();
    act(() => { option('notes').click(); });
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    open();
    act(() => { option('New space…').click(); });
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    render({ kind: 'new', name: '' });
    expect(host.querySelector('input')).not.toBeNull();
    act(() => { option('No space').click(); });
    expect(picked).toEqual([{ kind: 'existing', name: 'notes' }, { kind: 'new', name: '' }, { kind: 'none' }]);
  });

  it('holds the error back until the new name has been typed in', () => {
    render({ kind: 'new', name: '' }, 'Name the new space');
    open();
    expect(host.textContent).not.toContain('Name the new space');
    const input = host.querySelector('input')!;
    expect(input.placeholder).toBe('e.g. team-notes');
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(host.textContent).toContain('Name the new space');
  });

  it('asks for a new space\'s name, slugified, and shows the error', () => {
    render({ kind: 'new', name: '' }, 'Name the new space');
    open();
    const input = host.querySelector('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Team Notes');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(picked).toEqual([{ kind: 'new', name: 'team-notes' }]);
    expect(host.textContent).toContain('Name the new space');
  });

  it('does not let Enter in the new-space name submit the form', () => {
    render({ kind: 'new', name: 'team-notes' });
    open();
    const input = host.querySelector('input')!;
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => { input.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(true);
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it('moves with the arrow keys, closes on Escape, and closes on an outside click', () => {
    render({ kind: 'none' });
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    act(() => { trigger().dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(option('No space'));
    act(() => {
      option('No space').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(option('notes'));
    act(() => {
      option('notes').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(option('New space…'));
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { document.dispatchEvent(esc); });
    expect(esc.defaultPrevented).toBe(true);
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());

    open();
    act(() => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('closes when the page dismisses the menu, and does not open while disabled', () => {
    render({ kind: 'none' });
    open();
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    render({ kind: 'none' }, '', 1);
    expect(host.querySelector('[role="listbox"]')).toBeNull();

    act(() => root.render(
      <SpacePicker value={{ kind: 'none' }} spaces={spaces} disabled onChange={c => picked.push(c)} />,
    ));
    const button = trigger();
    expect(button.disabled).toBe(true);
    act(() => { button.click(); });
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('marks each choice with its space colour, and No space neutral', () => {
    const swatch = (el: Element | null) => el?.querySelector<HTMLElement>('.space-swatch');
    render({ kind: 'existing', name: 'notes' });
    expect(swatch(trigger())?.style.getPropertyValue('--space-color')).toBe(spaceColor('notes').hex);
    open();
    expect(swatch(option('notes'))?.style.getPropertyValue('--space-color')).toBe(spaceColor('notes').hex);
    expect(swatch(option('No space'))?.dataset.space).toBe('none');

    render({ kind: 'none' });
    expect(swatch(trigger())?.dataset.space).toBe('none');
    render({ kind: 'new', name: '' });
    expect(swatch(trigger())?.dataset.space).toBe('none');
    render({ kind: 'new', name: 'team-' });
    expect(swatch(trigger())?.style.getPropertyValue('--space-color')).toBe(spaceColor('team').hex);
  });
});
