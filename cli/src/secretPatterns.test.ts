import { describe, expect, it } from 'vitest';
import { findSecretsInText } from './secretPatterns.js';

describe('secret patterns (the CLI copy)', () => {
  it('names each kind found in a text', () => {
    expect(findSecretsInText(`token: ghp_${'a'.repeat(36)}`)).toEqual(['GitHub token']);
    expect(findSecretsInText(`box tmag_${'x'.repeat(20)}\ncli tmcli_${'y'.repeat(20)}`)).toEqual(['termag agent token', 'termag CLI token']);
    expect(findSecretsInText('a memory about tokens in general')).toEqual([]);
  });
});
