import { describe, expect, test } from 'vitest';
import { attachSessionArgv } from './tmux.js';

describe('attachSessionArgv', () => {
  test('attaches, then sets window-size latest from inside the attached client', () => {
    expect(attachSessionArgv('u-p-agent')).toEqual(['attach-session', '-t', 'u-p-agent', ';', 'set-option', '-w', 'window-size', 'latest']);
  });
});
