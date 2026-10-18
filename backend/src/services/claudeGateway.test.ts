import { describe, it, expect } from 'vitest';
import {
  API_KEY_HELPER_PLACEHOLDER,
  getClaudeGatewayConfig,
  gatewaySettings,
  parseModelPins,
} from './claudeGateway';

const ENV = {
  CLAUDE_GATEWAY_URL: 'https://bedrock.termag.example.com/bedrock/',
  CLAUDE_BEDROCK_REGION: 'us-east-2',
  CLAUDE_BEDROCK_MODELS: 'opus=us.anthropic.claude-opus-x, sonnet=us.anthropic.claude-sonnet-x,haiku=us.anthropic.claude-haiku-x',
  CLAUDE_DEFAULT_MODEL: 'opus',
  CLAUDE_FAST_MODEL: 'haiku',
};

describe('getClaudeGatewayConfig', () => {
  it('parses a full config', () => {
    expect(getClaudeGatewayConfig(ENV)).toEqual({
      bedrockBaseUrl: 'https://bedrock.termag.example.com/bedrock',
      bedrockRegion: 'us-east-2',
      models: { opus: 'us.anthropic.claude-opus-x', sonnet: 'us.anthropic.claude-sonnet-x', haiku: 'us.anthropic.claude-haiku-x' },
      defaultModel: 'us.anthropic.claude-opus-x',
      fastModel: 'us.anthropic.claude-haiku-x',
    });
  });

  it('leaves the default and fast models to Claude Code when unset, and refuses an unknown tier', () => {
    const { CLAUDE_DEFAULT_MODEL: _d, CLAUDE_FAST_MODEL: _f, ...rest } = ENV;
    expect(getClaudeGatewayConfig(rest)).toMatchObject({ defaultModel: undefined, fastModel: undefined });
    expect(getClaudeGatewayConfig({ ...ENV, CLAUDE_DEFAULT_MODEL: 'opus-4' })).toBeNull();
  });

  it('is off when anything is missing, or the URL is not https', () => {
    for (const k of Object.keys(ENV).filter(k => !['CLAUDE_DEFAULT_MODEL', 'CLAUDE_FAST_MODEL'].includes(k))) {
      expect(getClaudeGatewayConfig({ ...ENV, [k]: '' })).toBeNull();
    }
    expect(getClaudeGatewayConfig({ ...ENV, CLAUDE_GATEWAY_URL: 'http://x/bedrock' })).toBeNull();
  });

  it('needs all three model pins', () => {
    expect(parseModelPins('opus=a,sonnet=b')).toBeNull();
  });
});

describe('gatewaySettings', () => {
  it('is the documented Bedrock-behind-a-gateway set, with no credential in it', () => {
    const cfg = getClaudeGatewayConfig(ENV)!;
    const s = gatewaySettings(cfg);
    expect(s).toEqual({
      apiKeyHelper: API_KEY_HELPER_PLACEHOLDER,
      env: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.termag.example.com/bedrock',
        CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
        AWS_REGION: 'us-east-2',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'us.anthropic.claude-opus-x',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'us.anthropic.claude-sonnet-x',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'us.anthropic.claude-haiku-x',
        ANTHROPIC_MODEL: 'us.anthropic.claude-opus-x',
        ANTHROPIC_SMALL_FAST_MODEL: 'us.anthropic.claude-haiku-x',
      },
    });
    expect(JSON.stringify(s)).not.toMatch(/ANTHROPIC_API_KEY|AWS_BEARER_TOKEN_BEDROCK|ANTHROPIC_AUTH_TOKEN/);
  });
});
