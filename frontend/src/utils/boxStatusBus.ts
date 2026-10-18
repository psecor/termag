import type { Instance, InstanceStatus } from '../types';

type Listener = (instanceId: string, status: InstanceStatus) => void;

/**
 * Box status changes as the box list sees them, for terminal panes waiting on
 * a stopped or starting box. The list already polls while a box is in
 * transition, so panes get the change without polling the API themselves.
 */
export class BoxStatusBus {
  private last = new Map<string, InstanceStatus>();
  private listeners = new Set<Listener>();

  /** Feed the latest box list; listeners hear only the boxes whose status changed. */
  publish(boxes: readonly Pick<Instance, 'id' | 'status'>[]): void {
    for (const b of boxes) {
      if (this.last.get(b.id) === b.status) continue;
      this.last.set(b.id, b.status);
      for (const fn of this.listeners) fn(b.id, b.status);
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}

export const boxStatusBus = new BoxStatusBus();
