// `claude -p … --output-format json` for the e2e boxes' stand-in Claude Code
// (E2E_FAKE_CLAUDE=1): one non-streaming answer, as the box's chat runner asks
// Haiku for a tool group's heading as the group starts
// (agent/tool-group-headings.js). It reads the group's JSON between <group>
// tags on stdin and answers in Claude Code's JSON result shape, after
// E2E_HEADING_DELAY_MS (default 1200, about what Haiku takes), so the heading
// line holds its placeholder first, as on a box. The headings for the
// stand-in turns (`survey`, `quiet survey`, `quiet check`, `triage`) are the
// ones real Haiku wrote for the same runs;
// any other run gets one made from its first call. E2E_HEADING_FAIL=1 makes
// every heading call fail, for the fallback.
//
//   node claude-json.mjs -p --model haiku --output-format json … < prompt
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const prompt = readFileSync(0, 'utf8');
let group = {};
try { group = JSON.parse(prompt.match(/<group>\n([\s\S]*?)\n<\/group>/)?.[1] ?? '{}'); } catch { /* not a group */ }
const first = group.first && typeof group.first === 'object' ? group.first : null;
const ran = first ? `${first.tool} ${first.description ?? ''} ${first.command ?? ''} ${first.target ?? ''}` : '';
const request = String(group.request ?? '');
// What real Haiku answered for these stand-in runs, from what each run starts with.
const RECORDED = [
  [() => /npm test/.test(ran) && /triage/.test(request), 'Reproduce and identify the failing test'],
  [() => /^Grep .*PORT/.test(ran), 'Locate environment variable port configuration'],
  [() => /^Edit /.test(ran), 'Apply default port and verify tests pass'],
  [() => /ls -la/.test(ran) && /^(long )?survey/.test(request), 'Examine repository structure and build setup'],
  [() => /ls -la/.test(ran) && /quiet survey/.test(request), 'Survey repository contents'],
  [() => /ls -la/.test(ran) && /quiet check/.test(request), 'Check repository contents and status'],
];
const what = String(first?.description || first?.command || first?.target || 'the work').replace(/[.]+$/, '');
const result = first ? (RECORDED.find(([match]) => match())?.[1] ?? `Work through ${what.charAt(0).toLowerCase()}${what.slice(1)}`) : '';
const at = process.argv.indexOf('--model');
const model = at >= 0 ? process.argv[at + 1] : 'sonnet';
// The env, or the box's ~/.termag/e2e-claude.env, as claude-stream.mjs reads it.
const boxSettings = (() => {
  try {
    return Object.fromEntries(readFileSync(join(homedir(), '.termag/e2e-claude.env'), 'utf8').split('\n')
      .map(l => /^\s*([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2].trim()]));
  } catch { return {}; }
})();
const setting = k => process.env[k] ?? boxSettings[k];
const delay = Number(setting('E2E_HEADING_DELAY_MS') ?? 1200);
setTimeout(() => {
  if (setting('E2E_HEADING_FAIL') === '1') { process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'stand-in heading failure' })}\n`); return; }
  process.stdout.write(`${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, duration_ms: delay, num_turns: 1, result,
    total_cost_usd: 0.0012, usage: { input_tokens: 1100, output_tokens: 10 }, modelUsage: { [`stub-${model}`]: { inputTokens: 1100, outputTokens: 10 } },
  })}\n`);
}, Number.isFinite(delay) && delay > 0 ? delay : 0);
