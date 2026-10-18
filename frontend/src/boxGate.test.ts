import { describe, expect, it } from 'vitest';
import { blocksManagedBox, gateArmed } from './boxGate';

describe('box gate', () => {
  it('blocks a managed box only for blocked', () => {
    expect(blocksManagedBox('blocked')).toBe(true);
    expect(blocksManagedBox('clear')).toBe(false);
    expect(blocksManagedBox('off')).toBe(false);
    expect(blocksManagedBox(undefined)).toBe(false);
  });

  it('is armed for clear and blocked', () => {
    expect(gateArmed('clear')).toBe(true);
    expect(gateArmed('blocked')).toBe(true);
    expect(gateArmed('off')).toBe(false);
    expect(gateArmed(undefined)).toBe(false);
  });
});
