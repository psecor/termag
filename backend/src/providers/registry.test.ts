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

  it('colours agree in both palettes, so a provider reads the same in the UI and from GET /api/providers', () => {
    for (const id of backend.PROVIDER_IDS) {
      expect(frontend.PROVIDERS[id].color, id).toEqual(backend.PROVIDERS[id].color);
      expect(frontend.PROVIDERS[id].lightColor, id).toEqual(backend.PROVIDERS[id].lightColor);
    }
  });

  it('mcpConnectors is set exactly where the backend has an mcpConfig (docs/mcp-broker.md)', () => {
    for (const id of backend.PROVIDER_IDS) {
      expect(!!frontend.PROVIDERS[id].mcpConnectors, id).toBe(!!backend.PROVIDERS[id].mcpConfig);
    }
    expect(frontend.PROVIDERS.human.mcpConnectors).toBeFalsy();
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

describe('chat engines (an automation run is a chat-runner turn)', () => {
  it('chatRunner, chatEngine and automationChatProvider agree on both sides', () => {
    for (const id of backend.PROVIDER_IDS) {
      expect(!!frontend.PROVIDERS[id].chatRunner, id).toBe(!!backend.PROVIDERS[id].chatRunner);
      expect(frontend.PROVIDERS[id].chatEngine, id).toBe(backend.PROVIDERS[id].chatEngine);
      expect(frontend.PROVIDERS[id].automationChatProvider, id).toBe(backend.PROVIDERS[id].automationChatProvider);
      expect(frontend.isChatRunnerProvider(id), id).toBe(backend.isChatRunnerProvider(id));
    }
    expect(frontend.CHAT_PROVIDER_ID).toBe(backend.CHAT_PROVIDER_ID);
  });

  it('every chat-runner provider names its engine, is never selectable, and reports as the runner', () => {
    const runners = backend.PROVIDER_IDS.filter(backend.isChatRunnerProvider);
    expect(runners).toEqual(['claude-chat', 'pi-chat']);
    for (const id of runners) {
      expect(backend.PROVIDERS[id].chatEngine, id).toBeDefined();
      expect(backend.PROVIDERS[id].selectable, id).toBe(false);
      expect(backend.PROVIDERS[id].statusSources, id).toEqual(['chat-runner']);
      expect(backend.PROVIDERS[id].processNames, id).toEqual([]);
    }
    for (const id of backend.PROVIDER_IDS.filter(id => !backend.isChatRunnerProvider(id))) {
      expect(backend.PROVIDERS[id].chatEngine, id).toBeUndefined();
    }
    expect(backend.chatEngineOf('claude-chat')).toBe('claude');
    expect(backend.chatEngineOf('pi-chat')).toBe('pi');
    expect(backend.chatEngineOf('claude')).toBeUndefined();
    expect(backend.chatEngineOf(null)).toBeUndefined();
    // The runner's source still books as Claude's chat, as before pi-chat existed.
    expect(backend.providerForSource('chat-runner')).toBe('claude-chat');
    expect(frontend.providerForSource('chat-runner')).toBe('claude-chat');
  });

  it('only claude-chat can be launched until the pi engine lands (A2 adds pi to SUPPORTED_CHAT_ENGINES)', () => {
    expect([...backend.SUPPORTED_CHAT_ENGINES]).toEqual(['claude']);
    expect(backend.PROVIDER_IDS.filter(backend.isLaunchableChatProvider)).toEqual(['claude-chat']);
    expect(backend.isLaunchableChatProvider('pi-chat')).toBe(false);
    expect(backend.isLaunchableChatProvider('claude')).toBe(false);
    expect(backend.isLaunchableChatProvider(undefined)).toBe(false);
  });

  it('automations run Claude as claude-chat, nothing else', () => {
    expect(backend.automationProviders()).toEqual(['claude']);
    expect(backend.PROVIDERS.claude.automationChatProvider).toBe(backend.CHAT_PROVIDER_ID);
    expect(backend.PROVIDERS.pi.automationChatProvider).toBeUndefined();
    for (const id of backend.automationProviders()) {
      expect(backend.isSelectableProvider(id), id).toBe(true);
      expect(backend.isChatRunnerProvider(backend.PROVIDERS[id].automationChatProvider), id).toBe(true);
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

describe('MCP connector targets', () => {
  it('every agent but DeepSeek gets the connectors; Claude through its own config, the rest through the bridge', () => {
    expect(backend.PROVIDER_IDS.filter(id => !backend.PROVIDERS[id].mcpConfig)).toEqual(['deepseek']);
    expect(backend.PROVIDERS.claude.mcpConfig).toBe('claude');
    expect(backend.PROVIDERS['claude-chat'].mcpConfig).toBe('claude');
    expect(backend.PROVIDERS.pi.mcpConfig).toBe('pi');
    expect(backend.PROVIDERS['pi-chat'].mcpConfig).toBe('pi');
    expect(backend.mcpAgentTargets()).toEqual(['auggie', 'codex', 'cursor', 'devin', 'gemini', 'pi', 'vibe']);
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

describe("Devin's poller waiting patterns", () => {
  const waiting = (line: string) => backend.PROVIDERS.devin.pollerConfig!.waitingPatterns!.some(p => p.test(line));
  it('reads the old and the newer approval footers', () => {
    expect(waiting('↑↓ select · ↵ confirm · esc cancel')).toBe(true);
    expect(waiting('↑↓ select · ↔ scope · e edit · ↵ confirm · esc cancel')).toBe(true);
    expect(waiting('↑↓ select · scroll')).toBe(false);
  });
  it("reads the list's cursor row when a narrow pane wraps the footer", () => {
    expect(waiting('❭ Allow ← ■□□□ → Once      Exec(gh auth)')).toBe(true);
    expect(waiting('❭ Deny')).toBe(true);
    expect(waiting('  Deny')).toBe(false);
    expect(waiting('│ + ❭ Allow')).toBe(false);
    expect(waiting('❭ Allowance check')).toBe(false);
  });
  it('is a whole line: a diff quoting the footer is not a prompt', () => {
    expect(waiting("│ +    expect(waiting('↑↓ select · ↔ scope · e edit · ↵ confirm · esc cancel')).toBe(true);")).toBe(false);
    expect(waiting('  ↑↓ select · ↔ scope · e edit · ↵ confirm · esc cancel  ')).toBe(true);
  });
  it('fails fast on a long line of hints with no confirm (pane text is untrusted)', () => {
    const hostile = `↑↓ select ${'· x '.repeat(2000)}`;
    const t = Date.now();
    expect(waiting(hostile)).toBe(false);
    expect(waiting(`${hostile}↵`)).toBe(false);
    expect(Date.now() - t).toBeLessThan(200);
  });
});
