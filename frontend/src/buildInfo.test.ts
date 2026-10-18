import { describe, it, expect } from 'vitest';
import { clientHeader } from './buildInfo';

describe('clientHeader', () => {
  it('names the phone client by its path', () => {
    expect(clientHeader('/termag/m/sessions', 'abc1234def56')).toBe('mobile/abc1234def56');
    expect(clientHeader('/termag/', 'abc1234def56')).toBe('web/abc1234def56');
    expect(clientHeader('/termag/admin/fleet', 'unknown')).toBe('web/unknown');
    expect(clientHeader('/termag/m', 'abc1234def56')).toBe('mobile/abc1234def56');
    // A workspace deep link that merely starts with "m" is not the phone client.
    expect(clientHeader('/termag/main-project', 'abc1234def56')).toBe('web/abc1234def56');
  });
});
