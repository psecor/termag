// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaunchChoice, LaunchChoiceMark } from './LaunchChoice';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('LaunchChoice', () => {
  it('draws its mark before the name, and indents the line under it past the mark', () => {
    act(() => root.render(<LaunchChoice checked mark={<LaunchChoiceMark kind="none" />} name="No space" line="sub" onClick={() => {}} />));
    const b = host.querySelector('button')!;
    expect(b.getAttribute('role')).toBe('radio');
    expect(b.querySelector('.chat-launch-box-name .space-swatch[data-space="none"]')).not.toBeNull();
    expect(b.classList.contains('chat-launch-choice-marked')).toBe(true);
  });

  it('has no mark when given none: the name alone, the line not indented', () => {
    act(() => root.render(<LaunchChoice checked={false} name="full-stack" line="acme/web" onClick={() => {}} />));
    const b = host.querySelector('button')!;
    expect(b.querySelector('.chat-launch-box-name')!.innerHTML).toBe('full-stack');
    expect(b.classList.contains('chat-launch-choice-marked')).toBe(false);
    expect(b.getAttribute('aria-checked')).toBe('false');
  });
});
