// `claude -p` for the e2e boxes' stand-in Claude Code (E2E_FAKE_CLAUDE=1): one
// Bedrock turn the way Claude Code makes it from the gateway keys
// termag-credentials merges into the user settings. It reads
// TERMAG_CLAUDE_SETTINGS (or ~/.claude/settings.json),
// requires CLAUDE_CODE_USE_BEDROCK=1, runs the apiKeyHelper for a token, and
// calls ANTHROPIC_BEDROCK_BASE_URL/model/<id>/invoke-with-response-stream with
// it as a bearer token (CLAUDE_CODE_SKIP_BEDROCK_AUTH). --model takes a tier
// (opus, sonnet, haiku, fast) or a profile id; the default is ANTHROPIC_MODEL.
//
//   node claude-bedrock.mjs [--model <tier|id>] <prompt>
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
let model = null;
const i = args.indexOf('--model');
if (i >= 0) { model = args[i + 1]; args.splice(i, 2); }
const prompt = args.join(' ') || 'hello';

const file = process.env.TERMAG_CLAUDE_SETTINGS || join(homedir(), '.claude', 'settings.json');
let settings;
try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch {
  console.error(`claude (stub): no settings at ${file}; log in to Claude on this box`);
  process.exit(1);
}
const env = settings.env ?? {};
if (env.CLAUDE_CODE_USE_BEDROCK !== '1' || !env.ANTHROPIC_BEDROCK_BASE_URL) {
  console.error(`claude (stub): ${file} does not hold the Bedrock gateway set`);
  process.exit(1);
}
const tiers = {
  opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL, sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
  haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL, fast: env.ANTHROPIC_SMALL_FAST_MODEL,
};
const id = model ? (tiers[model] ?? model) : env.ANTHROPIC_MODEL;
if (!id) { console.error('claude (stub): no model (ANTHROPIC_MODEL unset, no --model)'); process.exit(1); }

let token;
try { token = execSync(settings.apiKeyHelper, { encoding: 'utf8' }).trim(); } catch {
  console.error(`claude (stub): apiKeyHelper ${settings.apiKeyHelper} failed`);
  process.exit(1);
}

const url = `${env.ANTHROPIC_BEDROCK_BASE_URL.replace(/\/+$/, '')}/model/${encodeURIComponent(id)}/invoke-with-response-stream`;
console.log(`claude (stub): ${id} via ${env.ANTHROPIC_BEDROCK_BASE_URL}`);
const res = await fetch(url, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/vnd.amazon.eventstream' },
  body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 256, messages: [{ role: 'user', content: prompt }] }),
});
const buf = Buffer.from(await res.arrayBuffer());
if (res.status !== 200) {
  console.error(`claude (stub): HTTP ${res.status}: ${buf.toString('utf8').trim()}`);
  process.exit(1);
}
// AWS event-stream: [total][headers len][prelude crc][headers][payload][crc].
let text = '';
for (let o = 0; o + 12 <= buf.length;) {
  const total = buf.readUInt32BE(o);
  const hlen = buf.readUInt32BE(o + 4);
  const payload = JSON.parse(buf.subarray(o + 12 + hlen, o + total - 4).toString('utf8'));
  const event = JSON.parse(Buffer.from(payload.bytes, 'base64').toString('utf8'));
  if (event.type === 'content_block_delta') text += event.delta.text;
  if (event.type === 'message_stop') {
    const m = event['amazon-bedrock-invocationMetrics'] ?? {};
    console.log(text);
    console.log(`claude (stub): tokens in=${m.inputTokenCount} out=${m.outputTokenCount}`);
  }
  o += total;
}
