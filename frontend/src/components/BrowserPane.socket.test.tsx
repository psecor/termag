// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPane } from './BrowserPane';

// Records every dial; a test plays the server by calling onmessage/onclose.
class RecordingSocket {
  static OPEN = 1;
  static made: RecordingSocket[] = [];
  readyState = 1;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  constructor(public url: string) { RecordingSocket.made.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() {}
}
class StillObserver { observe() {} disconnect() {} }

let root: Root;
let host: HTMLDivElement;
const query = (i: number) => new URL(RecordingSocket.made[i].url).searchParams;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', StillObserver);
  vi.stubGlobal('WebSocket', RecordingSocket);
  RecordingSocket.made = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const dialAndDrop = async () => {
  await act(async () => { vi.advanceTimersByTime(10); });
  expect(RecordingSocket.made).toHaveLength(1);
  // Ready, then the socket drops (the laptop slept): the pane redials.
  await act(async () => { RecordingSocket.made[0].onmessage!({ data: JSON.stringify({ type: 'ready' }) }); });
  await act(async () => { RecordingSocket.made[0].onclose!({ code: 1006, reason: '' }); });
  await act(async () => { vi.advanceTimersByTime(20_000); });
  expect(RecordingSocket.made.length).toBeGreaterThanOrEqual(2);
};

describe('BrowserPane redials', () => {
  it('a reviewer\'s link page rides the dials until one is ready, not the redial to their parked browser', async () => {
    await act(async () => { root.render(<BrowserPane share={{ shareId: 'cshare0000000001', at: '/login' }} url="about:blank" onUrlChange={() => {}} />); });
    await dialAndDrop();
    expect(query(0).get('at')).toBe('/login');
    expect(query(1).get('share')).toBe('cshare0000000001');
    expect(query(1).has('at')).toBe(false);
  });

  it('an owner\'s share link likewise', async () => {
    await act(async () => { root.render(<BrowserPane projectId="p1" workstream="main" url="about:blank" onUrlChange={() => {}} openShare={{ shareId: 'cshare0000000001', at: '/flags' }} />); });
    await dialAndDrop();
    expect([query(0).get('openShare'), query(0).get('at')]).toEqual(['cshare0000000001', '/flags']);
    expect(query(1).has('openShare')).toBe(false);
    expect(query(1).has('at')).toBe(false);
  });

  it('an owner\'s share link asks what is listening only when the box could not open the share\'s app', async () => {
    const open = async (firstNavUrl: string) => {
      RecordingSocket.made = [];
      await act(async () => { root.render(<BrowserPane key={firstNavUrl} projectId="p1" workstream="main" url="about:blank" onUrlChange={() => {}} openShare={{ shareId: 'cshare0000000001', at: null }} />); });
      await act(async () => { vi.advanceTimersByTime(10); });
      const ws = RecordingSocket.made[RecordingSocket.made.length - 1];
      await act(async () => { ws.onmessage!({ data: JSON.stringify({ type: 'ready' }) }); });
      expect(ws.sent.filter((m: any) => m.type === 'suggest')).toHaveLength(0);
      await act(async () => { ws.onmessage!({ data: JSON.stringify({ type: 'nav', url: firstNavUrl, title: '' }) }); });
      return ws.sent.filter((m: any) => m.type === 'suggest').length;
    };
    expect(await open('http://127.0.0.2/flags')).toBe(0);
    expect(await open('about:blank')).toBe(1);
  });

  it('an owner\'s share link is spent once its dial is ready: the owner is told, and a remount carries nothing', async () => {
    const used = vi.fn();
    await act(async () => { root.render(<BrowserPane key="a" projectId="p1" workstream="main" url="about:blank" onUrlChange={() => {}} openShare={{ shareId: 'cshare0000000001', at: '/flags' }} onOpenShareUsed={used} />); });
    await act(async () => { vi.advanceTimersByTime(10); });
    expect(used).not.toHaveBeenCalled();
    await act(async () => { RecordingSocket.made[0].onmessage!({ data: JSON.stringify({ type: 'ready' }) }); });
    expect(used).toHaveBeenCalledTimes(1);
    // The dock collapsed and reopened: a new pane, given what its owner now holds.
    await act(async () => { root.render(<BrowserPane key="b" projectId="p1" workstream="main" url="http://127.0.0.2/elsewhere" onUrlChange={() => {}} openShare={null} onOpenShareUsed={used} />); });
    await act(async () => { vi.advanceTimersByTime(10); });
    const last = new URL(RecordingSocket.made[RecordingSocket.made.length - 1].url).searchParams;
    expect([last.has('openShare'), last.has('at'), last.get('url')]).toEqual([false, false, 'http://127.0.0.2/elsewhere']);
  });

  it('a reviewer page given a new at redials with it, not the one it mounted with', async () => {
    const page = (at: string) => <BrowserPane share={{ shareId: 'cshare0000000001', at }} url="about:blank" onUrlChange={() => {}} />;
    await act(async () => { root.render(page('/one')); });
    await act(async () => { vi.advanceTimersByTime(10); });
    await act(async () => { RecordingSocket.made[0].onmessage!({ data: JSON.stringify({ type: 'ready' }) }); });
    await act(async () => { root.render(page('/two')); });
    await act(async () => { vi.advanceTimersByTime(10); });
    expect(query(RecordingSocket.made.length - 1).get('at')).toBe('/two');
  });
});

describe('BrowserPane as a reviewer\'s pane', () => {
  const guestPane = async (props: Partial<React.ComponentProps<typeof BrowserPane>> = {}) => {
    await act(async () => { root.render(<BrowserPane share={{ shareId: 'cshare0000000001' }} url="about:blank" onUrlChange={() => {}} {...props} />); });
    await act(async () => { vi.advanceTimersByTime(10); });
    const ws = RecordingSocket.made[0];
    await act(async () => { ws.onmessage!({ data: JSON.stringify({ type: 'ready' }) }); });
    return ws;
  };

  it('lists a refused loopback address by name and counts other sites', async () => {
    const ws = await guestPane();
    await act(async () => {
      ws.onmessage!({ data: JSON.stringify({ type: 'blocked', origin: '127.0.0.2:9000', local: true }) });
      ws.onmessage!({ data: JSON.stringify({ type: 'blocked', origin: '127.0.0.2:9000', local: true }) });
      ws.onmessage!({ data: JSON.stringify({ type: 'blocked', origin: 'example.com:443', local: false }) });
      ws.onmessage!({ data: JSON.stringify({ type: 'blocked', origin: 'cdn.example:443', local: false }) });
    });
    expect([...host.querySelectorAll('.browser-pane-blocked-item')].map(e => e.textContent)).toEqual(["127.0.0.2:9000 isn't part of this preview"]);
    expect(host.querySelector('.browser-pane-blocked-dim')?.textContent).toBe('2 requests to other sites blocked');
    expect(ws.sent.some((m: any) => m.type === 'suggest')).toBe(false);
  });

  it('redials from the share\'s own first page when the share changed under it, and from where it was otherwise', async () => {
    const ws = await guestPane();
    await act(async () => { ws.onmessage!({ data: JSON.stringify({ type: 'nav', url: 'http://127.0.0.2:3012/old-app', title: '' }) }); });
    await act(async () => { ws.onclose!({ code: 1006, reason: '' }); });
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(query(1).get('url')).toBe('http://127.0.0.2:3012/old-app');
    const ws2 = RecordingSocket.made[1];
    await act(async () => { ws2.onmessage!({ data: JSON.stringify({ type: 'ready' }) }); });
    await act(async () => { ws2.onclose!({ code: 1012, reason: 'share updated' }); });
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(query(2).get('url')).toBe('about:blank');
  });

  it('hands the checkout up, and a refusal\'s own words win over its close code', async () => {
    const onCheckout = vi.fn();
    const onClosed = vi.fn();
    const ws = await guestPane({ onCheckout, onClosed });
    await act(async () => { ws.onmessage!({ data: JSON.stringify({ type: 'checkout', branch: 'feat', head: 'abc123', dirty: 2 }) }); });
    expect(onCheckout).toHaveBeenCalledWith({ branch: 'feat', head: 'abc123', dirty: 2 });
    await act(async () => {
      ws.onmessage!({ data: JSON.stringify({ type: 'exit', reason: 'Its owner stopped sharing this preview.' }) });
      ws.onclose!({ code: 4410, reason: 'revoked' });
    });
    expect(onClosed).toHaveBeenCalledWith(4410, 'revoked', 'Its owner stopped sharing this preview.');
    expect(host.textContent).toContain('Its owner stopped sharing this preview.');
    // Final: no redial.
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(RecordingSocket.made).toHaveLength(1);
  });

  it('shows the page\'s dialogs and sends the viewer\'s answer; the box can close one itself', async () => {
    const ws = await guestPane();
    expect(query(0).get('dialogs')).toBe('1');
    const buttons = () => [...host.querySelectorAll('.browser-pane-dialog button')].map(b => b.textContent);
    await act(async () => { ws.onmessage!({ data: JSON.stringify({ type: 'dialog', id: 1, kind: 'confirm', message: 'Delete this flag?' }) }); });
    expect(host.querySelector('.browser-pane-dialog-message')?.textContent).toBe('Delete this flag?');
    expect(buttons()).toEqual(['Cancel', 'OK']);
    await act(async () => { (host.querySelector('.browser-pane-dialog button.btn-primary') as HTMLButtonElement).click(); });
    expect(ws.sent).toContainEqual({ type: 'dialog', id: 1, accept: true });
    expect(host.querySelector('.browser-pane-dialog')).toBeNull();
    // A prompt sends its text; Cancel sends no text.
    await act(async () => { ws.onmessage!({ data: JSON.stringify({ type: 'dialog', id: 2, kind: 'prompt', message: 'Name?', defaultPrompt: 'flag-1' }) }); });
    const input = host.querySelector('.browser-pane-dialog input') as HTMLInputElement;
    expect(input.value).toBe('flag-1');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, 'flag-2'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { (host.querySelector('.browser-pane-dialog button.btn-primary') as HTMLButtonElement).click(); });
    expect(ws.sent).toContainEqual({ type: 'dialog', id: 2, accept: true, text: 'flag-2' });
    // An alert has only OK; the box answering it (a timeout, the page moved on) clears it.
    await act(async () => { ws.onmessage!({ data: JSON.stringify({ type: 'dialog', id: 3, kind: 'alert', message: 'Saved' }) }); });
    expect(buttons()).toEqual(['OK']);
    await act(async () => { ws.onmessage!({ data: JSON.stringify({ type: 'dialog-closed', id: 3 }) }); });
    expect(host.querySelector('.browser-pane-dialog')).toBeNull();
  });

  it('keeps a dialog modal: the canvas sends no input, Escape cancels, and a closed socket clears it', async () => {
    const ws = await guestPane();
    const canvas = host.querySelector('canvas') as HTMLCanvasElement;
    const typeA = () => act(async () => { canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true })); });
    const inputs = () => ws.sent.filter(m => (m as { type: string }).type === 'input').length;
    await typeA();
    const before = inputs();
    expect(before).toBeGreaterThan(0);
    await act(async () => { ws.onmessage!({ data: JSON.stringify({ type: 'dialog', id: 4, kind: 'confirm', message: 'Leave?' }) }); });
    expect(host.querySelector('.browser-pane-dialog-shield')).not.toBeNull();
    await typeA();
    expect(inputs()).toBe(before);
    // Escape in the dialog is Cancel.
    const form = host.querySelector('.browser-pane-dialog') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(ws.sent).toContainEqual({ type: 'dialog', id: 4, accept: false });
    expect(host.querySelector('.browser-pane-dialog')).toBeNull();
    expect(host.querySelector('.browser-pane-dialog-shield')).toBeNull();
    await typeA();
    expect(inputs()).toBe(before + 1);
    // A key pressed before the dialog opened is released after it goes, never left down.
    const keyEvents = () => ws.sent.filter(m => (m as { type: string }).type === 'input').map(m => (m as { event: { type: string; code?: string } }).event).filter(e => e.code === 'KeyB').map(e => e.type);
    await act(async () => { canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true })); });
    await act(async () => { ws.onmessage!({ data: JSON.stringify({ type: 'dialog', id: 6, kind: 'confirm', message: 'Sure?' }) }); });
    await act(async () => { canvas.dispatchEvent(new KeyboardEvent('keyup', { key: 'b', code: 'KeyB', bubbles: true })); });
    await act(async () => { canvas.dispatchEvent(new KeyboardEvent('keyup', { key: 'c', code: 'KeyC', bubbles: true })); });
    expect(keyEvents()).toEqual(['keyDown']);
    await act(async () => { (host.querySelector('.browser-pane-dialog button.btn-primary') as HTMLButtonElement).click(); });
    expect(keyEvents()).toEqual(['keyDown', 'keyUp']);
    expect(ws.sent.some(m => (m as { event?: { code?: string } }).event?.code === 'KeyC')).toBe(false);
    // The socket closing takes the dialog with it: the box answers it.
    await act(async () => { ws.onmessage!({ data: JSON.stringify({ type: 'dialog', id: 5, kind: 'alert', message: 'Hi' }) }); });
    await act(async () => { ws.onclose!({ code: 1006, reason: '' }); });
    expect(host.querySelector('.browser-pane-dialog')).toBeNull();
  });
});
