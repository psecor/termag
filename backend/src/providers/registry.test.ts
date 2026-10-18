import { describe, expect, it } from 'vitest';
import * as backend from './registry';
import * as frontend from '../../../frontend/src/providers/registry';
import { canHandOffFrom, canRestartInto } from '../services/agentHandoff';

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

describe('handoff modes', () => {
  it('the frontend offers exactly the modes the backend can do', () => {
    for (const id of backend.PROVIDER_IDS) {
      const be = backend.PROVIDERS[id];
      const expected = canHandOffFrom(id)
        ? [...(be.clearCommand ? ['clear'] : []), ...(be.compactCommand ? ['compact'] : []), 'restart']
        : undefined;
      expect(frontend.PROVIDERS[id].handoffModes, id).toEqual(expected);
      expect(!!frontend.PROVIDERS[id].handoffTarget, id).toBe(canRestartInto(id));
    }
  });

  it('only agents that can write their handoff are handed off from; any prompt-launchable one is restarted into', () => {
    expect(backend.PROVIDER_IDS.filter(canHandOffFrom)).toEqual(['claude', 'pi']);
    expect(backend.PROVIDER_IDS.filter(canRestartInto)).toEqual(['claude', 'cursor', 'devin', 'pi']);
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
