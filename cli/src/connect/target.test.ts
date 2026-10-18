import { describe, expect, it } from 'vitest';
import { ssmTarget, type ConnectBox } from './target.js';

function box(state: string): ConnectBox {
  return {
    id: 'b1', name: 'devbox', addressable: true, kind: 'ec2', state, status: state,
    agentConnected: false, error: null, projects: [], ec2InstanceId: 'i-0abc', region: 'us-east-2',
  };
}

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
