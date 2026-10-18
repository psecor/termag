import { describe, expect, it } from 'vitest';
import { isValidBoxName } from './boxNames';

describe('isValidBoxName', () => {
  it('allows letters, digits, - and _', () => {
    expect(isValidBoxName('dev_box-2')).toBe(true);
  });

  it('refuses spaces, slashes, dots and the empty name', () => {
    for (const name of ['my machine', 'a/b', 'box.1', '']) expect(isValidBoxName(name)).toBe(false);
  });
});
