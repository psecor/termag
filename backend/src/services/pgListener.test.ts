import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeClient extends EventEmitter {
  static made: FakeClient[] = [];
  queries: string[] = [];
  ended = false;
  failConnect = false;
  constructor() { super(); FakeClient.made.push(this); }
  async connect() { if (this.failConnect) throw new Error('refused'); }
  async query(sql: string) { this.queries.push(sql); }
  async end() { this.ended = true; }
}

vi.mock('pg', () => ({ Client: FakeClient }));
vi.mock('../db', () => ({ iamPoolConfig: () => ({}) }));
vi.mock('../config/env', () => ({ iamAuthEnabled: () => false }));

const flush = () => new Promise(r => setTimeout(r, 0));

let listen: typeof import('./pgListener').listen;
const stops: Array<() => void> = [];

beforeEach(async () => {
  vi.resetModules();
  FakeClient.made = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  ({ listen } = await import('./pgListener'));
});

afterEach(() => {
  while (stops.length) stops.pop()!();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the shared LISTEN connection', () => {
  it('serves every channel over one connection, each payload to its own handler', async () => {
    const a: string[] = [];
    const b: string[] = [];
    stops.push(listen('termag_ask_reply', { onPayload: p => a.push(p) }));
    stops.push(listen('termag_space_file', { onPayload: p => b.push(p) }));
    await flush();
    expect(FakeClient.made).toHaveLength(1);
    const c = FakeClient.made[0];
    expect(c.queries).toEqual(expect.arrayContaining(['LISTEN termag_ask_reply', 'LISTEN termag_space_file']));
    c.emit('notification', { channel: 'termag_space_file', payload: '{"s":"x"}' });
    c.emit('notification', { channel: 'termag_ask_reply', payload: 'm:0:1:' });
    c.emit('notification', { channel: 'other', payload: 'x' });
    expect(a).toEqual(['m:0:1:']);
    expect(b).toEqual(['{"s":"x"}']);
  });

  it('reconnects after a drop, LISTENs again and tells each channel', async () => {
    vi.useFakeTimers();
    const listening = vi.fn();
    stops.push(listen('termag_space_file', { onPayload: () => {}, onListening: listening }));
    await vi.advanceTimersByTimeAsync(0);
    expect(listening).toHaveBeenCalledTimes(1);
    FakeClient.made[0].emit('error', new Error('reset'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeClient.made).toHaveLength(2);
    expect(FakeClient.made[0].ended).toBe(true);
    expect(FakeClient.made[1].queries).toEqual(['LISTEN termag_space_file']);
    expect(listening).toHaveBeenCalledTimes(2);
  });

  it('closes the connection once the last channel stops', async () => {
    const stopA = listen('termag_ask_reply', { onPayload: () => {} });
    const stopB = listen('termag_space_file', { onPayload: () => {} });
    await flush();
    stopA();
    expect(FakeClient.made[0].queries).toContain('UNLISTEN termag_ask_reply');
    expect(FakeClient.made[0].ended).toBe(false);
    stopB();
    expect(FakeClient.made[0].ended).toBe(true);
  });

  it('refuses a channel name that is not a plain identifier', () => {
    expect(() => listen('x; DROP TABLE users', { onPayload: () => {} })).toThrow();
  });
});
