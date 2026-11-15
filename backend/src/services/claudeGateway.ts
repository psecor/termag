/**
 * Claude Code through the termag Bedrock gateway. Boxes get Claude Code settings pointing at the gateway, and an
 * apiKeyHelper that prints the box's own agent token; termag-credentials
 * merges them into the box user's ~/.claude/settings.json. The gateway (Envoy, a
 * separate service) checks that token with the orchestrator on every call
 * (routes/claudeAuthz.ts) and drops it before it signs for Bedrock, so there is
 * no Claude credential on the box and the Bedrock grant stays on the gateway's
 * own role.
 *
 * Off unless CLAUDE_GATEWAY_URL, CLAUDE_BEDROCK_REGION and
 * CLAUDE_BEDROCK_MODELS are set.
 */

export interface ClaudeGatewayConfig {
  bedrockBaseUrl: string;
  bedrockRegion: string;
  models: { opus: string; sonnet: string; haiku: string };
  // Profiles for Claude Code's starting model and its small/fast model, from
  // the CLAUDE_DEFAULT_MODEL and CLAUDE_FAST_MODEL tiers; unset leaves
  // Claude Code's own choice.
  defaultModel?: string;
  fastModel?: string;
}

type Tier = keyof ClaudeGatewayConfig['models'];
const TIERS: Tier[] = ['opus', 'sonnet', 'haiku'];

export function parseModelPins(raw: string | undefined): ClaudeGatewayConfig['models'] | null {
  if (!raw) return null;
  const pins: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=').map(s => s?.trim());
    if (k && v) pins[k] = v;
  }
  if (!pins.opus || !pins.sonnet || !pins.haiku) return null;
  return { opus: pins.opus, sonnet: pins.sonnet, haiku: pins.haiku };
}

export function getClaudeGatewayConfig(env: NodeJS.ProcessEnv = process.env): ClaudeGatewayConfig | null {
  const bedrockBaseUrl = env.CLAUDE_GATEWAY_URL?.trim().replace(/\/+$/, '');
  const bedrockRegion = env.CLAUDE_BEDROCK_REGION?.trim();
  const models = parseModelPins(env.CLAUDE_BEDROCK_MODELS);
  if (!bedrockBaseUrl?.startsWith('https://') || !bedrockRegion || !models) return null;
  const tier = (raw: string | undefined): string | undefined | null => {
    const t = raw?.trim();
    if (!t) return undefined;
    return (TIERS as string[]).includes(t) ? models[t as Tier] : null;
  };
  const defaultModel = tier(env.CLAUDE_DEFAULT_MODEL);
  const fastModel = tier(env.CLAUDE_FAST_MODEL);
  if (defaultModel === null || fastModel === null) return null;
  return {
    defaultModel,
    fastModel,
    bedrockBaseUrl,
    bedrockRegion,
    models,
  };
}

/** Replaced on the box with the absolute path of termag-claude-token. */
export const API_KEY_HELPER_PLACEHOLDER = '@TERMAG_CLAUDE_TOKEN@';

/** The flag claude-context-tokens: where gateway sessions auto-compact, in tokens. */
export const CLAUDE_CONTEXT_TOKENS_FLAG = 'claude-context-tokens';
export const DEFAULT_CLAUDE_CONTEXT_TOKENS = 400_000;
// The range Claude Code takes for CLAUDE_CODE_AUTO_COMPACT_WINDOW; outside it,
// it warns and uses the nearer end.
const AUTO_COMPACT_MIN = 100_000;
const AUTO_COMPACT_MAX = 1_000_000;

/**
 * claude-context-tokens' value as CLAUDE_CODE_AUTO_COMPACT_WINDOW, or null for
 * the model's full window (0, a negative number, or not a number). The rest is
 * rounded and clamped to Claude Code's range, so a box never gets a value
 * Claude Code warns about.
 */
export function autoCompactWindow(tokens: number): number | null {
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  return Math.min(AUTO_COMPACT_MAX, Math.max(AUTO_COMPACT_MIN, Math.round(tokens)));
}

/**
 * The gateway settings for a box. They hold no credential: the token comes
 * from apiKeyHelper, which Claude Code re-runs every 5 minutes and on a 401.
 * Claude Code sends it as `Authorization: Bearer`.
 *
 * `compactWindow` (autoCompactWindow) is CLAUDE_CODE_AUTO_COMPACT_WINDOW:
 * Claude Code compacts the conversation once its context reaches that many
 * tokens, and the model keeps its own window (Claude Code caps the value at
 * it). CLAUDE_CODE_MAX_CONTEXT_TOKENS would not do: on a model id Claude Code
 * recognizes, such as the gateway's `us.anthropic.claude-…` pins, it applies
 * only with compaction turned off. As an env key it reaches every Claude Code
 * run that reads the owner's settings, the chat runner's scratch config
 * included (agent/chat-runner.js prepareChatConfigDir), and outranks a
 * `/autocompact` or `autoCompactWindow` the owner saved. An owner who sets the
 * variable in their own settings keeps theirs (termag-credentials
 * settings_merge).
 */
export function gatewaySettings(cfg: ClaudeGatewayConfig, { compactWindow = null }: { compactWindow?: number | null } = {}): Record<string, unknown> {
  return {
    apiKeyHelper: API_KEY_HELPER_PLACEHOLDER,
    env: {
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_BEDROCK_BASE_URL: cfg.bedrockBaseUrl,
      // Without it Claude Code signs with SigV4 and drops the bearer token.
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
      AWS_REGION: cfg.bedrockRegion,
      ANTHROPIC_DEFAULT_OPUS_MODEL: cfg.models.opus,
      ANTHROPIC_DEFAULT_SONNET_MODEL: cfg.models.sonnet,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: cfg.models.haiku,
      ...(cfg.defaultModel ? { ANTHROPIC_MODEL: cfg.defaultModel } : {}),
      ...(cfg.fastModel ? { ANTHROPIC_SMALL_FAST_MODEL: cfg.fastModel } : {}),
      ...(compactWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(compactWindow) } : {}),
    },
  };
}
