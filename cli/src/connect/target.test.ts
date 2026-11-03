import { describe, expect, it } from 'vitest';
import { parseRef, pickBox, ssmTarget, type ConnectBox } from './target.js';

function box(state: string, name = 'devbox'): ConnectBox {
  return {
    id: `id-${name}`, name, addressable: true, kind: 'ec2', flavor: 'full', state, status: state,
    agentConnected: false, error: null, projects: [], ec2InstanceId: 'i-0abc', region: 'us-east-2',
  };
}

describe('parseRef', () => {
  it('needs a box unless the command takes a default one', () => {
    expect(() => parseRef(undefined)).toThrow('Name a box');
    expect(parseRef(undefined, { defaultBox: true })).toEqual({ box: null, project: null });
    expect(parseRef('devbox/fix', { defaultBox: true })).toEqual({ box: 'devbox', project: 'fix' });
  });
});

describe('pickBox', () => {
  it('takes the only box when none is named', () => {
    expect(pickBox([box('running')], null).name).toBe('devbox');
  });

  it('asks for a name when there are several boxes', () => {
    expect(() => pickBox([box('running'), box('stopped', 'other')], null))
      .toThrow('You have 2 boxes (devbox, other); name the one to use');
  });

  it('says there is no box to default to', () => {
    expect(() => pickBox([], null)).toThrow('You have no boxes; create one with `termag box create <name>`');
  });

  it('finds a named box by name or id', () => {
    const boxes = [box('running'), box('stopped', 'other')];
    expect(pickBox(boxes, 'other').name).toBe('other');
    expect(pickBox(boxes, 'id-devbox').name).toBe('devbox');
  });
});

describe('ssmTarget', () => {
  it('targets a running box in its own region', () => {
    expect(ssmTarget(box('running'), 'us-west-2')).toEqual({ instanceId: 'i-0abc', region: 'us-east-2' });
  });

  it('says how to resume a hibernated box', () => {
    expect(() => ssmTarget(box('hibernated'), 'us-east-2'))
      .toThrow('devbox is hibernated; resume it (`termag box start devbox` or the web UI)');
  });

  it('says a hibernating box can be resumed once it has hibernated', () => {
    expect(() => ssmTarget(box('hibernating'), 'us-east-2'))
      .toThrow('devbox is hibernating; once it is hibernated, resume it with `termag box start devbox`');
  });

  it('keeps the generic message for other transitional states', () => {
    expect(() => ssmTarget(box('starting'), 'us-east-2')).toThrow('devbox is starting; try again once it is running');
  });
});
