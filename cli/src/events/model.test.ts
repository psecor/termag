import { describe, expect, it } from 'vitest';
import type { Box } from '../api.js';
import { EventTracker, describeEvent, parseFrame } from './model.js';

const AT = '2026-10-28T14:05:00.000Z';

function box(over: Partial<Box> = {}): Box {
  return { id: 'b1', name: 'devbox', addressable: true, kind: 'ec2', state: 'running', status: 'ready', agentConnected: true, error: null, projects: [], ...over };
}

function status(over: Record<string, unknown> = {}) {
  const f = parseFrame(JSON.stringify({ type: 'status', session: 'alice-web-agent', instanceId: 'b1', status: 'working', updatedAt: AT, ...over }));
  if (f?.kind !== 'status') throw new Error('not a status frame');
  return f;
}

describe('box events', () => {
  it('start with every box, then report only the boxes whose state changed', () => {
    const t = new EventTracker();
    expect(t.boxList([box(), box({ id: 'b2', name: 'spare', state: 'stopped', status: 'stopped', agentConnected: false })], AT)).toEqual([
      { type: 'box', at: AT, box: { id: 'b1', name: 'devbox' }, state: 'running', previous: null, agentConnected: true },
      { type: 'box', at: AT, box: { id: 'b2', name: 'spare' }, state: 'stopped', previous: null, agentConnected: false },
    ]);
    expect(t.boxList([box(), box({ id: 'b2', name: 'spare', state: 'stopped', status: 'stopped', agentConnected: false })], AT)).toEqual([]);
    expect(t.boxList([box({ state: 'stopping', status: 'stopping' }), box({ id: 'b2', name: 'spare', state: 'stopped', status: 'stopped', agentConnected: false })], AT)).toEqual([
      { type: 'box', at: AT, box: { id: 'b1', name: 'devbox' }, state: 'stopping', previous: 'running', agentConnected: true },
    ]);
  });

  it('are not sent for a change that is not the state', () => {
    const t = new EventTracker();
    t.boxList([box()], AT);
    expect(t.boxList([box({ name: 'renamed', agentConnected: false, projects: [{ id: 'p1', name: 'web' }] })], AT)).toEqual([]);
  });

  it('say terminated when a box leaves the list, once', () => {
    const t = new EventTracker();
    t.boxList([box()], AT);
    expect(t.boxList([], AT)).toEqual([
      { type: 'box', at: AT, box: { id: 'b1', name: 'devbox' }, state: 'terminated', previous: 'running', agentConnected: false },
    ]);
    expect(t.boxList([], AT)).toEqual([]);
  });

  it('carry the error of a failed box', () => {
    const t = new EventTracker();
    expect(t.boxList([box({ state: 'failed', status: 'failed', error: 'RunInstances refused' })], AT)[0]).toMatchObject({ state: 'failed', error: 'RunInstances refused' });
  });

  it('poll fast only while a box is going up or down', () => {
    const t = new EventTracker();
    t.boxList([box()], AT);
    expect(t.settling()).toBe(false);
    t.boxList([box({ state: 'starting', status: 'starting' })], AT);
    expect(t.settling()).toBe(true);
  });
});

describe('session events', () => {
  it('report a session the first time, then only when its status or waiting reason changes', () => {
    const t = new EventTracker();
    t.boxList([box()], AT);
    expect(t.status(status(), AT)).toEqual({
      type: 'session', at: AT, session: 'alice-web-agent', box: { id: 'b1', name: 'devbox' }, status: 'working', previous: null,
    });
    expect(t.status(status({ contextTokens: 120000, rateLimited: null }), AT)).toBeNull();
    expect(t.status(status({ status: 'waiting', waitingReason: 'approval' }), AT)).toEqual({
      type: 'session', at: AT, session: 'alice-web-agent', box: { id: 'b1', name: 'devbox' }, status: 'waiting', previous: 'working', waitingReason: 'approval',
    });
    expect(t.status(status({ status: 'waiting', waitingReason: 'user_input' }), AT)).toMatchObject({ status: 'waiting', previous: 'waiting', waitingReason: 'user_input' });
    expect(t.status(status({ status: 'idle', stoppedAt: '2026-10-28T14:06:00.000Z' }), AT)).toEqual({
      type: 'session', at: AT, session: 'alice-web-agent', box: { id: 'b1', name: 'devbox' }, status: 'idle', previous: 'waiting', stoppedAt: '2026-10-28T14:06:00.000Z',
    });
  });

  it('leave stoppedAt out when the orchestrator does not send it, as one from before it does not', () => {
    const t = new EventTracker();
    for (const stoppedAt of [undefined, null, '', 'not a date']) {
      const e = t.status(status({ session: `s-${String(stoppedAt)}`, status: 'idle', stoppedAt }), AT);
      expect(e).toMatchObject({ type: 'session', status: 'idle', previous: null });
      expect(e).not.toHaveProperty('stoppedAt');
    }
  });

  it('drop a waiting reason that comes with a status other than waiting', () => {
    expect(new EventTracker().status(status({ status: 'idle', waitingReason: 'approval' }), AT)).not.toHaveProperty('waitingReason');
  });

  it('keep sessions of the same name on two boxes apart', () => {
    const t = new EventTracker();
    t.status(status(), AT);
    expect(t.status(status({ instanceId: 'b2' }), AT)).toMatchObject({ box: { id: 'b2' }, previous: null });
  });

  it('name the box only when it is in your box list, and leave it out for the orchestrator host', () => {
    const t = new EventTracker();
    expect(t.status(status({ instanceId: 'someone-elses' }), AT)?.box).toEqual({ id: 'someone-elses' });
    expect(t.status(status({ instanceId: null, session: 'alice-host-agent' }), AT)).not.toHaveProperty('box');
    expect(t.status(status({ instanceId: undefined, session: 'alice-old-agent' }), AT)).not.toHaveProperty('box');
  });
});

describe('frames', () => {
  it('ignore what is not a status or a box-list change', () => {
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame('[]')).toBeNull();
    expect(parseFrame(JSON.stringify({ type: 'status', session: 7, status: 'idle' }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: 'heartbeat', ts: 1 }))).toEqual({ kind: 'other' });
    expect(parseFrame(JSON.stringify({ type: 'workspace', what: 'projects' }))).toEqual({ kind: 'other' });
    expect(parseFrame(JSON.stringify({ type: 'workspace', what: 'boxes' }))).toEqual({ kind: 'boxes-changed' });
  });
});

describe('describeEvent', () => {
  it('writes one line a person can read', () => {
    expect(describeEvent({ type: 'box', at: AT, box: { id: 'b1', name: 'devbox' }, state: 'stopped', previous: 'stopping', agentConnected: false }))
      .toBe(`${AT} box devbox: stopping -> stopped`);
    expect(describeEvent({ type: 'session', at: AT, session: 'alice-web-agent', box: { id: 'b1', name: 'devbox' }, status: 'waiting', previous: 'working', waitingReason: 'approval' }))
      .toBe(`${AT} session alice-web-agent on devbox: working -> waiting (approval)`);
  });
});
