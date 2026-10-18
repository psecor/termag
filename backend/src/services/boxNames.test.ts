import { describe, expect, it } from 'vitest';
import * as frontend from '../../../frontend/src/utils/boxNames';
import { BOX_NAME_ERROR, isValidBoxName } from './boxNames';

const SAMPLES = ['dev_box-2', 'A', 'my machine', 'a/b', 'box.1', 'café', '', ' devbox'];

describe('isValidBoxName', () => {
  it('allows letters, digits, - and _', () => {
    expect(isValidBoxName('dev_box-2')).toBe(true);
    expect(isValidBoxName('A')).toBe(true);
  });

  it('refuses spaces, slashes, dots, unicode and the empty name', () => {
    for (const name of SAMPLES.slice(2)) expect(isValidBoxName(name), name).toBe(false);
  });

  it('agrees with the web UI copy', () => {
    for (const name of SAMPLES) expect(frontend.isValidBoxName(name), name).toBe(isValidBoxName(name));
    expect(frontend.BOX_NAME_ERROR).toBe(BOX_NAME_ERROR);
  });
});
