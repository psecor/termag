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
  return host.querySelector('.chat-space-trigger') as HTMLButtonElement;
}

function open() {
  act(() => { trigger().click(); });
}

/** The dialog is portaled to the body, outside the host. */
function dialog(): HTMLElement | null {
  return document.querySelector('.chat-space-dialog');
}

/** A choice's name, without New space's decorative "+". */
function nameOf(o: Element): string | undefined {
  const el = o.querySelector('.chat-launch-box-name')?.cloneNode(true) as HTMLElement | undefined;
  el?.querySelectorAll('[aria-hidden="true"]').forEach(n => n.remove());
  return el?.textContent ?? undefined;
}

function option(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('.chat-space-dialog [role="radio"]')].find(o => nameOf(o) === name);
  if (!found) throw new Error(`missing option ${name}`);
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
  it('is a trigger like the box, with no caret, that opens a dialog of no space, editable spaces and a new one', () => {
    render({ kind: 'none' });
    const button = trigger();
    expect(button.textContent).toBe('No space');
    expect(button.className).toContain('chat-launch-trigger');
    expect(button.querySelector('.chat-compose-caret')).toBeNull();
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Space (optional), No space');
    expect(dialog()).toBeNull();
    expect(host.textContent).not.toContain('shared file store');
    open();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(dialog()?.getAttribute('role')).toBe('dialog');
    expect([...document.querySelectorAll('.chat-space-dialog [role="radio"]')].map(nameOf)).toEqual(['No space', 'notes', 'New space']);
    expect(option('No space').getAttribute('aria-checked')).toBe('true');
    expect(dialog()?.textContent).toContain("This session's box can read and write it");
    expect(dialog()?.querySelector('input')).toBeNull();
  });

  it('closes on No space or a space, and stays open on New space for its name', () => {
    render({ kind: 'none' });
    open();
    act(() => { option('notes').click(); });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    open();
    act(() => { option('New space').click(); });
    expect(dialog()).not.toBeNull();
    render({ kind: 'new', name: '' });
    expect(dialog()?.querySelector('input')).not.toBeNull();
    expect(document.activeElement).toBe(dialog()?.querySelector('input'));
    act(() => { option('No space').click(); });
    expect(dialog()).toBeNull();
    expect(picked).toEqual([{ kind: 'existing', name: 'notes' }, { kind: 'new', name: '' }, { kind: 'none' }]);
  });

  it('holds the error back until the new name has been typed in', () => {
    render({ kind: 'new', name: '' }, 'Name the new space');
    open();
    expect(document.body.textContent).not.toContain('Name the new space');
    const input = dialog()!.querySelector('input')!;
    expect(input.placeholder).toBe('e.g. team-notes');
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(dialog()?.textContent).toContain('Name the new space');
  });

  it("asks for a new space's name, slugified, and shows the error on the trigger once closed", () => {
    render({ kind: 'new', name: '' }, 'Name the new space');
    open();
    const input = dialog()!.querySelector('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Team Notes');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(picked).toEqual([{ kind: 'new', name: 'team-notes' }]);
    expect(dialog()?.textContent).toContain('Name the new space');
    act(() => { (dialog()!.querySelector('.chat-launch-dialog-actions button') as HTMLButtonElement).click(); });
    expect(dialog()).toBeNull();
    expect(trigger().getAttribute('aria-invalid')).toBe('true');
    expect(host.textContent).toContain('Name the new space');
  });

  it('takes Enter in the new name as Done, never as a submit', () => {
    render({ kind: 'new', name: 'team-notes' });
    open();
    const input = dialog()!.querySelector('input')!;
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => { input.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(true);
    expect(dialog()).toBeNull();
  });

  it('closes on Escape or Done, back on the trigger', () => {
    render({ kind: 'none' });
    open();
    act(() => { dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    open();
    act(() => { (dialog()!.querySelector('.chat-launch-dialog-actions button') as HTMLButtonElement).click(); });
    expect(dialog()).toBeNull();
  });

  it('closes when the page dismisses its menus, and does not open while disabled', () => {
    render({ kind: 'none' });
    open();
    expect(dialog()).not.toBeNull();
    render({ kind: 'none' }, '', 1);
    expect(dialog()).toBeNull();

    act(() => root.render(
      <SpacePicker value={{ kind: 'none' }} spaces={spaces} disabled onChange={c => picked.push(c)} />,
    ));
    const button = trigger();
    expect(button.disabled).toBe(true);
    act(() => { button.click(); });
    expect(dialog()).toBeNull();
  });

  it('marks each choice with its space colour, and No space neutral', () => {
    const swatch = (el: Element | null) => el?.querySelector<HTMLElement>('.space-swatch');
    render({ kind: 'existing', name: 'notes' });
    expect(swatch(trigger())?.style.getPropertyValue('--space-color')).toBe(spaceColor('notes').hex);
    open();
    expect(swatch(option('notes'))?.style.getPropertyValue('--space-color')).toBe(spaceColor('notes').hex);
    expect(swatch(option('No space'))?.dataset.space).toBe('none');
    act(() => { option('notes').click(); });

    render({ kind: 'none' });
    expect(swatch(trigger())?.dataset.space).toBe('none');
    render({ kind: 'new', name: '' });
    expect(swatch(trigger())?.dataset.space).toBe('none');
    render({ kind: 'new', name: 'team-' });
    expect(swatch(trigger())?.style.getPropertyValue('--space-color')).toBe(spaceColor('team').hex);
  });
});
