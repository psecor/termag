import { describe, it, expect } from 'vitest';
import { isReservedProjectName } from './projectNames';

describe('isReservedProjectName', () => {
  it('reserves MetaTerm case-insensitively', () => {
    expect(isReservedProjectName('MetaTerm')).toBe(true);
    expect(isReservedProjectName('metaterm')).toBe(true);
    expect(isReservedProjectName('METATERM')).toBe(true);
    expect(isReservedProjectName('  MetaTerm ')).toBe(true);
  });
  it('leaves ordinary names alone', () => {
    expect(isReservedProjectName('termag')).toBe(false);
    expect(isReservedProjectName('metaterm-2')).toBe(false);
    expect(isReservedProjectName('my-metaterm')).toBe(false);
    expect(isReservedProjectName('')).toBe(false);
  });
});
