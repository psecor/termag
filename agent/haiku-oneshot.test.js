'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { firstLine, oneshotArgs, oneshotEnv, resultText } = require('./haiku-oneshot');

test('oneshotArgs: Haiku in print mode with nothing to act with and nothing saved', () => {
  const args = oneshotArgs('You name things.');
  const at = flag => args[args.indexOf(flag) + 1];
  assert.equal(at('--model'), 'haiku');
  assert.equal(at('--tools'), '', 'no tools');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(at('--mcp-config')), { mcpServers: {} });
  assert.deepEqual(JSON.parse(at('--settings')), { disableAllHooks: true });
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(at('--setting-sources'), 'user');
  assert.equal(at('--system-prompt'), 'You name things.');
  assert.equal(at('--output-format'), 'json');
  assert.ok(!args.includes('--bare'), '--bare skips the gateway apiKeyHelper');
});

test('oneshotArgs: a telemetry resource goes in the one --settings, beside the hooks closure', () => {
  const args = oneshotArgs('You name things.', { OTEL_RESOURCE_ATTRIBUTES: 'termag.session.kind=oneshot' });
  assert.equal(args.filter(a => a === '--settings').length, 1);
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { disableAllHooks: true, env: { OTEL_RESOURCE_ATTRIBUTES: 'termag.session.kind=oneshot' } });
});

test('oneshotEnv: thinking off, the rest as given', () => {
  assert.deepEqual(oneshotEnv({ A: '1', MAX_THINKING_TOKENS: '8000' }), { A: '1', MAX_THINKING_TOKENS: '0' });
});

test('resultText / firstLine: the answer of a good result, its first line without wrapping quotes', () => {
  assert.equal(resultText(JSON.stringify({ type: 'result', result: 'x' })), 'x');
  assert.equal(resultText(JSON.stringify({ type: 'result', is_error: true, result: 'x' })), null);
  assert.equal(resultText('nope'), null);
  assert.equal(firstLine('\n  "**Hi there**"  \nmore'), 'Hi there');
});
