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
      expect(!!frontend.PROVIDERS[id].orchestratorSkill, id).toBe(!!backend.PROVIDERS[id].orchestratorSkill);
    }
    expect(frontend.PROVIDERS.human.selectable).toBe(false);
    expect(frontend.SELECTABLE_PROVIDER_IDS).toEqual(backend.SELECTABLE_PROVIDER_IDS);
  });

  it('statusSources agree, so a live status names the same provider on both sides', () => {
    for (const id of backend.PROVIDER_IDS) {
      expect(frontend.PROVIDERS[id].statusSources, id).toEqual(backend.PROVIDERS[id].statusSources);
    }
    // The desktop app's threads run Claude Code: their time is
    // Claude's, but they run beside the pane, so they never say what the pane runs.
    expect(backend.providerForSource('t3:claude')).toBe('claude');
    expect(frontend.providerForSource('t3:claude')).toBe('claude');
    expect(frontend.runningProviderForSource('t3:claude')).toBeUndefined();
  });

  it('the model backends agree: the same ids per harness, the same names', () => {
    for (const id of backend.PROVIDER_IDS) {
      expect(frontend.PROVIDERS[id].backends ?? [], id).toEqual(backend.backendsFor(id));
    }
    expect(frontend.MODEL_BACKENDS).toEqual(backend.MODEL_BACKENDS);
    for (const id of backend.PROVIDER_IDS) {
      for (const b of backend.backendsFor(id)) expect(backend.MODEL_BACKENDS[b], `${id} ${b}`).toBeDefined();
    }
  });
});

describe('model backends', () => {
  it("Claude Code (a pane's and the simple UI chat's) and pi can run on Fireworks; null is every harness default", () => {
    expect(backend.PROVIDER_IDS.filter(id => backend.backendsFor(id).length > 0)).toEqual(['claude', 'claude-chat', 'pi']);
    expect(backend.isBackendFor('claude', 'fireworks')).toBe(true);
    expect(backend.isBackendFor('claude', null)).toBe(true);
    expect(backend.isBackendFor('cursor', null)).toBe(true);
    expect(backend.isBackendFor('cursor', 'fireworks')).toBe(false);
    expect(backend.isBackendFor('claude', 'bedrock')).toBe(false);
  });
});

describe('orchestrator skill', () => {
  it('is offered only for the Claude agents termag-reconcile installs it for', () => {
    expect(backend.PROVIDER_IDS.filter(id => backend.PROVIDERS[id].orchestratorSkill)).toEqual(['claude', 'claude-chat']);
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
