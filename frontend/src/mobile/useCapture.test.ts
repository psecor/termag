import { describe, it, expect } from 'vitest';
import { intervalFor } from './useCapture';

describe('intervalFor', () => {
  it('polls fast while working, slowly otherwise', () => {
    expect(intervalFor('working')).toBe(2_000);
    expect(intervalFor('waiting')).toBe(10_000);
    expect(intervalFor('idle')).toBe(30_000);
    expect(intervalFor('not_running')).toBe(30_000);
    expect(intervalFor(undefined)).toBe(30_000);
  });
});
