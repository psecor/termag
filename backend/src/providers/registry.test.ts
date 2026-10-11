import { describe, expect, it } from 'vitest';
import * as backend from './registry';
import * as frontend from '../../../frontend/src/providers/registry';

describe('provider registries stay in sync (gotcha: two files, by hand)', () => {
  it('frontend ids = backend ids + human', () => {
    const be = new Set(backend.PROVIDER_IDS);
    const fe = new Set(frontend.PROVIDER_IDS);
    expect(fe.has('human')).toBe(true);
    expect(be.has('human')).toBe(false);
    fe.delete('human');
    expect([...fe].sort()).toEqual([...be].sort());
  });

  it('selectable agrees on every shared id, and human is never selectable', () => {
    for (const id of backend.PROVIDER_IDS) {
      expect(frontend.PROVIDERS[id].selectable, id).toBe(backend.PROVIDERS[id].selectable);
      expect(frontend.PROVIDERS[id].displayName, id).toBe(backend.PROVIDERS[id].displayName);
      expect(frontend.PROVIDERS[id].badge, id).toBe(backend.PROVIDERS[id].badge);
    }
    expect(frontend.PROVIDERS.human.selectable).toBe(false);
    expect(frontend.SELECTABLE_PROVIDER_IDS).toEqual(backend.SELECTABLE_PROVIDER_IDS);
  });
});

describe('selectable providers', () => {
  it('is the curated create-project set', () => {
    expect(backend.SELECTABLE_PROVIDER_IDS).toEqual(['claude', 'cursor', 'devin', 'pi']);
  });

  it('isSelectableProvider accepts only that set', () => {
    expect(backend.isSelectableProvider('claude')).toBe(true);
    expect(backend.isSelectableProvider('codex')).toBe(false); // still a valid PROVIDER_IDS entry
    expect(backend.PROVIDER_IDS).toContain('codex');
    expect(backend.isSelectableProvider('human')).toBe(false);
    expect(backend.isSelectableProvider(undefined)).toBe(false);
    expect(backend.isSelectableProvider(null)).toBe(false);
  });

  it('the fallback default is selectable', () => {
    expect(backend.isSelectableProvider('claude')).toBe(true);
  });
});
