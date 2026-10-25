import { describe, expect, it } from 'vitest';
import {
  BROWSER_PANE_CAPABILITY, BROWSER_VIEWPORT, agentSupportsBrowserPane, clampViewport, normalizeBrowserUrl,
  parseBrowserClientMessage, parseBrowserInputEvent, parseBrowserPaneQuery, parseBrowserSuggestions, toAgentBrowserMessage,
} from './browserPane';

describe('browser pane helpers', () => {
  it('reads the capability from the hello', () => {
    expect(agentSupportsBrowserPane(['tmux-create-command-v1', BROWSER_PANE_CAPABILITY])).toBe(true);
    expect(agentSupportsBrowserPane(['tmux-create-command-v1'])).toBe(false);
    expect(agentSupportsBrowserPane([])).toBe(false);
  });

  it('clamps the viewport and falls back for garbage', () => {
    expect(clampViewport(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(clampViewport('10', '99999')).toEqual({ width: BROWSER_VIEWPORT.minWidth, height: BROWSER_VIEWPORT.maxHeight });
    expect(clampViewport(null, 'x')).toEqual({ width: BROWSER_VIEWPORT.defaultWidth, height: BROWSER_VIEWPORT.defaultHeight });
  });

  it('accepts http(s) and about:blank, prefixes a bare host, refuses other schemes', () => {
    expect(normalizeBrowserUrl(null)).toBe('about:blank');
    expect(normalizeBrowserUrl('')).toBe('about:blank');
    expect(normalizeBrowserUrl('127.0.0.2:3012/flags')).toBe('http://127.0.0.2:3012/flags');
    expect(normalizeBrowserUrl('https://example.test/a')).toBe('https://example.test/a');
    expect(normalizeBrowserUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeBrowserUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeBrowserUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizeBrowserUrl('mailto:someone@example.test')).toBeNull();
    expect(normalizeBrowserUrl('chrome://settings')).toBeNull();
    expect(normalizeBrowserUrl('x'.repeat(3000))).toBeNull();
    expect(normalizeBrowserUrl(5)).toBeNull();
  });

  it('parses the socket query, requiring a project and a usable url', () => {
    expect(parseBrowserPaneQuery(new URLSearchParams('projectId=p1&workstream=feat&url=localhost:3000&width=900&height=700')))
      .toEqual({ projectId: 'p1', workstream: 'feat', url: 'http://localhost:3000/', width: 900, height: 700 });
    expect(parseBrowserPaneQuery(new URLSearchParams('projectId=p1')))
      .toEqual({ projectId: 'p1', workstream: 'main', url: 'about:blank', width: BROWSER_VIEWPORT.defaultWidth, height: BROWSER_VIEWPORT.defaultHeight });
    expect(parseBrowserPaneQuery(new URLSearchParams('url=http://x/'))).toEqual({ error: 'projectId param required' });
    expect(parseBrowserPaneQuery(new URLSearchParams('projectId=p1&url=ftp://x/'))).toEqual({ error: 'url must be http or https' });
    expect(parseBrowserPaneQuery(new URLSearchParams('projectId=p1&workstream=../../etc'))).toEqual({ error: 'workstream name invalid' });
    expect(parseBrowserPaneQuery(new URLSearchParams('projectId=p1&workstream=feat/one'))).toEqual({ error: 'workstream name invalid' });
  });

  it('bounds every field of an input event and refuses unknown shapes', () => {
    expect(parseBrowserInputEvent({ kind: 'mouse', type: 'mousePressed', x: 10.4, y: 20.6, button: 'left', buttons: 1, clickCount: 1, modifiers: 8 }))
      .toEqual({ kind: 'mouse', type: 'mousePressed', x: 10, y: 21, button: 'left', buttons: 1, clickCount: 1, modifiers: 8 });
    expect(parseBrowserInputEvent({ kind: 'mouse', type: 'mouseWheel', x: 1, y: 2, deltaY: 99999, button: 'back', buttons: -1, clickCount: 7, modifiers: 'x' }))
      .toEqual({ kind: 'mouse', type: 'mouseWheel', x: 1, y: 2, button: 'none', buttons: 0, clickCount: 3, modifiers: 0, deltaX: 0, deltaY: 4000 });
    expect(parseBrowserInputEvent({ kind: 'mouse', type: 'mousePressed', x: 'a', y: 1 })).toBeNull();
    expect(parseBrowserInputEvent({ kind: 'mouse', type: 'mouseDoubleClicked', x: 1, y: 1 })).toBeNull();
    expect(parseBrowserInputEvent({ kind: 'key', type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 }))
      .toEqual({ kind: 'key', type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13, modifiers: 0 });
    expect(parseBrowserInputEvent({ kind: 'key', type: 'keyDown', key: 'a', windowsVirtualKeyCode: 70000, text: 'too long text' }))
      .toEqual({ kind: 'key', type: 'keyDown', key: 'a', code: '', modifiers: 0 });
    expect(parseBrowserInputEvent({ kind: 'key', type: 'char', key: 'a' })).toBeNull();
    expect(parseBrowserInputEvent({ kind: 'key', type: 'keyDown' })).toBeNull();
    expect(parseBrowserInputEvent({ kind: 'text', text: 'hi' })).toEqual({ kind: 'text', text: 'hi' });
    expect(parseBrowserInputEvent({ kind: 'text', text: 'x'.repeat(5000) })).toBeNull();
    expect(parseBrowserInputEvent({ kind: 'touch' })).toBeNull();
    expect(parseBrowserInputEvent('mouse')).toBeNull();
  });

  it('parses the viewer frames and drops everything else', () => {
    expect(parseBrowserClientMessage(JSON.stringify({ type: 'input', event: { kind: 'text', text: 'a' } }))).toEqual({ type: 'input', event: { kind: 'text', text: 'a' } });
    expect(parseBrowserClientMessage(JSON.stringify({ type: 'input', event: { kind: 'nope' } }))).toBeNull();
    expect(parseBrowserClientMessage(JSON.stringify({ type: 'navigate', url: 'example.test' }))).toEqual({ type: 'navigate', url: 'http://example.test/' });
    expect(parseBrowserClientMessage(JSON.stringify({ type: 'navigate', url: 'javascript:alert(1)' }))).toBeNull();
    // A word and digits is a host and a port, never a scheme: the result is always http(s).
    expect(parseBrowserClientMessage(JSON.stringify({ type: 'navigate', url: 'javascript:1' }))).toEqual({ type: 'navigate', url: 'http://javascript:1/' });
    expect(parseBrowserClientMessage(JSON.stringify({ type: 'history', action: 'back' }))).toEqual({ type: 'history', action: 'back' });
    expect(parseBrowserClientMessage(JSON.stringify({ type: 'history', action: 'home' }))).toBeNull();
    expect(parseBrowserClientMessage(JSON.stringify({ type: 'resize', width: 5000, height: 100 }))).toEqual({ type: 'resize', width: BROWSER_VIEWPORT.maxWidth, height: BROWSER_VIEWPORT.minHeight });
    expect(parseBrowserClientMessage(JSON.stringify({ type: 'resize', width: '5000', height: 100 }))).toBeNull();
    expect(parseBrowserClientMessage(JSON.stringify({ type: 'suggest' }))).toEqual({ type: 'suggest' });
    expect(parseBrowserClientMessage(JSON.stringify({ type: 'reset-profile', extra: 1 }))).toEqual({ type: 'reset-profile' });
    // A dialog answer: a positive integer id and a boolean, the prompt's text bounded.
    expect(parseBrowserClientMessage(JSON.stringify({ type: 'dialog', id: 3, accept: true, text: 'x'.repeat(3000) }))).toEqual({ type: 'dialog', id: 3, accept: true, text: 'x'.repeat(2000) });
    expect(parseBrowserClientMessage(JSON.stringify({ type: 'dialog', id: 3, accept: false }))).toEqual({ type: 'dialog', id: 3, accept: false });
    for (const bad of [{ type: 'dialog', id: 0, accept: true }, { type: 'dialog', id: 1.5, accept: true }, { type: 'dialog', id: '1', accept: true }, { type: 'dialog', id: 1, accept: 'yes' }]) {
      expect(parseBrowserClientMessage(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull();
    }
    expect(parseBrowserClientMessage(JSON.stringify({ type: 'exec', cmd: 'rm' }))).toBeNull();
    expect(parseBrowserClientMessage('not json')).toBeNull();
    expect(parseBrowserClientMessage('"string"')).toBeNull();
  });

  it('maps viewer frames onto the agent protocol', () => {
    expect(toAgentBrowserMessage({ type: 'input', event: { kind: 'text', text: 'a' } })).toEqual({ type: 'browser-input', event: { kind: 'text', text: 'a' } });
    expect(toAgentBrowserMessage({ type: 'navigate', url: 'http://x/' })).toEqual({ type: 'browser-navigate', url: 'http://x/' });
    expect(toAgentBrowserMessage({ type: 'history', action: 'reload' })).toEqual({ type: 'browser-history', action: 'reload' });
    expect(toAgentBrowserMessage({ type: 'resize', width: 640, height: 480 })).toEqual({ type: 'browser-resize', width: 640, height: 480 });
    expect(toAgentBrowserMessage({ type: 'reset-profile' })).toEqual({ type: 'browser-profile-reset' });
    expect(toAgentBrowserMessage({ type: 'dialog', id: 3, accept: true, text: 'a' })).toEqual({ type: 'browser-dialog-answer', id: 3, accept: true, text: 'a' });
    expect(toAgentBrowserMessage({ type: 'dialog', id: 3, accept: false })).toEqual({ type: 'browser-dialog-answer', id: 3, accept: false });
  });
});

describe('browser suggestions', () => {
  it('keeps http(s) urls with bounded titles and drops the rest', () => {
    expect(parseBrowserSuggestions({ items: [
      { url: 'http://127.0.0.2/', title: 'Sign in', status: 200 },
      { url: '127.0.0.1:3000', title: 'x'.repeat(100) },
      { url: 'javascript:alert(1)', title: 'no' },
      { url: 'about:blank' },
      { title: 'no url' },
      'garbage',
    ] })).toEqual([
      { url: 'http://127.0.0.2/', title: 'Sign in', status: 200 },
      { url: 'http://127.0.0.1:3000/', title: 'x'.repeat(80) },
    ]);
    expect(parseBrowserSuggestions(null)).toEqual([]);
    expect(parseBrowserSuggestions({ items: 'nope' })).toEqual([]);
  });
});
