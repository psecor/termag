import { describe, expect, it } from 'vitest';
import { BoxStatusBus } from './boxStatusBus';

describe('BoxStatusBus', () => {
  it('reports only the boxes whose status changed since the last list', () => {
    const bus = new BoxStatusBus();
    const heard: string[] = [];
    bus.subscribe((id, status) => heard.push(`${id}:${status}`));
    bus.publish([{ id: 'a', status: 'stopped' }, { id: 'b', status: 'ready' }]);
    bus.publish([{ id: 'a', status: 'stopped' }, { id: 'b', status: 'ready' }]);
    bus.publish([{ id: 'a', status: 'starting' }, { id: 'b', status: 'ready' }]);
    expect(heard).toEqual(['a:stopped', 'b:ready', 'a:starting']);
  });

  it('stops calling a listener once it unsubscribes', () => {
    const bus = new BoxStatusBus();
    const heard: string[] = [];
    const off = bus.subscribe((id, status) => heard.push(`${id}:${status}`));
    off();
    bus.publish([{ id: 'a', status: 'ready' }]);
    expect(heard).toEqual([]);
  });
});
