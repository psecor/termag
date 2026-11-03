import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ gatewayEnabled: true as boolean | null, asked: [] as unknown[] }));
vi.mock('../db', () => ({
  prisma: {
    user: {
      findUnique: async (q: unknown) => {
        state.asked.push(q);
        return state.gatewayEnabled === null ? null : { claudeGatewayEnabled: state.gatewayEnabled };
      },
    },
  },
}));

import { chatLaunchFor } from './chatLaunch';

const box = { ownerId: 'u1', instanceId: 'box1', capabilities: [] as string[] };
const PINS = {
  CLAUDE_GATEWAY_URL: 'https://gateway.example/bedrock',
  CLAUDE_BEDROCK_REGION: 'us-east-2',
  CLAUDE_BEDROCK_MODELS: 'opus=us.anthropic.claude-opus-5-5,sonnet=us.anthropic.claude-sonnet-5-5,haiku=us.anthropic.claude-haiku-4-5-20251001-v1:0',
  CLAUDE_DEFAULT_MODEL: 'opus',
};

beforeEach(() => { state.gatewayEnabled = true; state.asked = []; });

describe('chatLaunchFor on the default backend', () => {
  it('launches a stored tier as itself, and no tier (or the retired "auto") on Sonnet, never without a model', async () => {
    expect(await chatLaunchFor({ backend: null, model: 'opus' }, box)).toEqual({ ok: true, launch: { model: 'opus' } });
    expect(await chatLaunchFor({ backend: null, model: null }, box)).toEqual({ ok: true, launch: { model: 'sonnet' } });
    expect(await chatLaunchFor({ backend: null, model: 'auto' }, box)).toEqual({ ok: true, launch: { model: 'sonnet' } });
  });

  describe('with the gateway configured', () => {
    beforeEach(() => { for (const [k, v] of Object.entries(PINS)) vi.stubEnv(k, v); });
    afterEach(() => { vi.unstubAllEnvs(); });

    it("pins the tier's profile while the owner has the gateway on", async () => {
      expect(await chatLaunchFor({ backend: null, model: 'opus' }, box)).toEqual({ ok: true, launch: { model: 'us.anthropic.claude-opus-5-5' } });
      expect(await chatLaunchFor({ backend: null, model: 'haiku' }, box)).toEqual({ ok: true, launch: { model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' } });
      expect(await chatLaunchFor({ backend: null, model: null }, box)).toEqual({ ok: true, launch: { model: 'us.anthropic.claude-sonnet-5-5' } });
      expect(state.asked).toContainEqual({ where: { id: 'u1' }, select: { claudeGatewayEnabled: true } });
    });

    it('sends the alias for an owner who turned the gateway off, Sonnet when no tier is stored', async () => {
      state.gatewayEnabled = false;
      expect(await chatLaunchFor({ backend: null, model: 'opus' }, box)).toEqual({ ok: true, launch: { model: 'opus' } });
      expect(await chatLaunchFor({ backend: null, model: 'sonnet' }, box)).toEqual({ ok: true, launch: { model: 'sonnet' } });
      expect(await chatLaunchFor({ backend: null, model: 'haiku' }, box)).toEqual({ ok: true, launch: { model: 'haiku' } });
      expect(await chatLaunchFor({ backend: null, model: null }, box)).toEqual({ ok: true, launch: { model: 'sonnet' } });
    });

    it('sends the alias when the owner cannot be read', async () => {
      state.gatewayEnabled = null;
      expect(await chatLaunchFor({ backend: null, model: 'opus' }, box)).toEqual({ ok: true, launch: { model: 'opus' } });
    });
  });
});
