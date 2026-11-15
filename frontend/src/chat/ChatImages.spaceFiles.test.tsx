// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boxFileStatus, ComposerImages, MessageTextFiles } from './ChatImages';
import type { BoxFile } from './chatTextFiles';

const path = 'attachments/ws1/20261107T101500Z-a1b2c3/logs.zip';
const base: BoxFile = { id: 'b1', name: 'logs.zip', size: 1000, path: null, status: 'uploading' };

describe('boxFileStatus', () => {
  it('says where each file is going and where it went', () => {
    expect(boxFileStatus(base)).toBe('uploading…');
    expect(boxFileStatus({ ...base, space: 'team-alpha' })).toBe('uploading…');
    expect(boxFileStatus({ ...base, space: 'team-alpha', sent: 420 })).toBe('uploading 42%…');
    // Never 100% before the space confirms it.
    expect(boxFileStatus({ ...base, space: 'team-alpha', sent: 1000 })).toBe('uploading 99%…');
    expect(boxFileStatus({ ...base, status: 'waking' })).toBe('waking the box…');
    expect(boxFileStatus({ ...base, status: 'kept', path, space: 'team-alpha', url: 'u' })).toBe('in space');
    expect(boxFileStatus({ ...base, status: 'kept', path: '.termag-attachments/0123456789abcdef/logs.zip' })).toBe('on the box');
  });
});

describe('space files in the composer and the bubble', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  const statusOf = () => container.querySelector('.chat-attachment-status')?.textContent ?? null;

  it('says "in space" (and which, in its title) on a chip the space keeps, "on the box" and why where it fell back, and nothing for a plain box file', () => {
    act(() => root.render(<ComposerImages images={[]} boxFiles={[{ ...base, status: 'kept', path, space: 'team-alpha', url: 'u' }]} onRemove={() => {}} />));
    expect(statusOf()).toBe('in space');
    expect(container.querySelector('[data-in-space]')?.getAttribute('title')).toBe(`logs.zip · 1 KB · in space team-alpha at ${path}`);
    act(() => root.render(<ComposerImages images={[]} boxFiles={[{ ...base, status: 'kept', path: '.termag-attachments/0123456789abcdef/logs.zip', fellBack: 'you can only read team-alpha' }]} onRemove={() => {}} />));
    expect(statusOf()).toBe('on the box');
    expect(container.querySelector('.chat-attachment')?.getAttribute('title')).toContain('(you can only read team-alpha)');
    act(() => root.render(<ComposerImages images={[]} boxFiles={[{ ...base, status: 'kept', path: '.termag-attachments/0123456789abcdef/logs.zip' }]} onRemove={() => {}} />));
    expect(statusOf()).toBeNull();
  });

  it('links a sent space file on this page\'s origin, whatever URL the message carried', () => {
    act(() => root.render(<MessageTextFiles files={[]} boxFiles={[{ name: 'logs.zip', path, size: '1 KB', space: 'team-alpha', url: 'https://evil.example/x' }]} />));
    const a = container.querySelector<HTMLAnchorElement>('a[data-space-file]')!;
    expect(a.href).toBe(`${window.location.origin}/files/team-alpha/${path}`);
    expect(a.rel).toContain('noopener');
  });
});
