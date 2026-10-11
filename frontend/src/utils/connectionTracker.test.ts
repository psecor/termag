import { describe, it, expect, vi } from 'vitest';
import { ConnectionTracker } from './connectionTracker';

describe('ConnectionTracker contact sources', () => {
  it('records a socket frame against both clocks', () => {
    const t = new ConnectionTracker();
    t.contact('socket', 1000);
    expect(t.snapshot.lastContactAt).toBe(1000);
    expect(t.snapshot.lastSocketContactAt).toBe(1000);
  });

  it('leaves the socket clock untouched for HTTP evidence', () => {
    // The whole point of the split: a probe or a REST call must not be able to
    // make a dead status socket look alive.
    const t = new ConnectionTracker();
    t.contact('socket', 1000);
    t.contact('http', 90_000);
    expect(t.snapshot.lastContactAt).toBe(90_000);
    expect(t.snapshot.lastSocketContactAt).toBe(1000);
  });

  it('clears the failure count on contact from either source', () => {
    const t = new ConnectionTracker();
    t.failure();
    t.failure();
    expect(t.snapshot.consecutiveFailures).toBe(2);
    t.contact('http', 1000);
    expect(t.snapshot.consecutiveFailures).toBe(0);
  });

  it('notifies subscribers on every change', () => {
    const t = new ConnectionTracker();
    const seen = vi.fn();
    const off = t.subscribe(seen);
    t.contact('socket', 1000);
    t.setSocketOpen(true);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    t.contact('socket', 2000);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe('ConnectionTracker.reconnectNow', () => {
  it('calls the socket owner handler', () => {
    const t = new ConnectionTracker();
    const reconnect = vi.fn();
    t.reconnectSocket = reconnect;
    t.reconnectNow();
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no socket owner is mounted', () => {
    const t = new ConnectionTracker();
    expect(() => t.reconnectNow()).not.toThrow();
  });

  it('kicks registered terminal panes even when they still look connected', () => {
    // The overlay going away used to leave half-open PTY sockets sending into
    // the void, because Terminal skipped retry while connectionState was
    // `connected`. reconnectNow is the one path that must reach them.
    const t = new ConnectionTracker();
    const pane = vi.fn();
    const off = t.registerTerminalReconnect(pane);
    t.reconnectNow();
    expect(pane).toHaveBeenCalledTimes(1);
    off();
    t.reconnectNow();
    expect(pane).toHaveBeenCalledTimes(1);
  });
});
