import { beforeEach, describe, expect, it, vi } from 'vitest';

const recorded: Array<{ name: string; attributes: unknown }> = [];
vi.mock('../observability', () => ({
  recordProductEvent: (name: string, attributes: unknown) => { recorded.push({ name, attributes }); },
}));

const { recordLabOpened } = await import('./labOpened');

beforeEach(() => { recorded.length = 0; });

describe('lab.opened', () => {
  it('is one product event, with the way out as termag.from and nothing else', () => {
    recordLabOpened('session-menu');
    recordLabOpened('phone');
    expect(recorded).toEqual([
      { name: 'lab.opened', attributes: { 'termag.from': 'session-menu' } },
      { name: 'lab.opened', attributes: { 'termag.from': 'phone' } },
    ]);
  });
});
