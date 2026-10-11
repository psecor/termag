'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dialArgs, refusedForWantOfQueryToken, redialDelayMs, DRAIN_CLOSE_CODE } = require('./agent-dial');

test('the token goes in the Authorization header, not the URL', () => {
  const { url, options } = dialArgs('wss://termag.example.com/termag/ws/agent', 'tmag_abc');
  assert.equal(url, 'wss://termag.example.com/termag/ws/agent');
  assert.deepEqual(options, { headers: { Authorization: 'Bearer tmag_abc' } });
});

test('a token left in a configured URL is dropped from it', () => {
  const { url } = dialArgs('ws://h:3040/termag/ws/agent?token=tmag_old&x=1', 'tmag_abc');
  assert.equal(url, 'ws://h:3040/termag/ws/agent?x=1');
});

test('the query form, for an orchestrator from before the header', () => {
  const { url, options } = dialArgs('ws://h:3040/termag/ws/agent', 'tmag_a+b/c');
  assert.equal(new URL(dialArgs('ws://h:3040/termag/ws/agent', 'tmag_a+b/c', { tokenInQuery: true }).url).searchParams.get('token'), 'tmag_a+b/c');
  assert.equal(url, 'ws://h:3040/termag/ws/agent');
  assert.ok(options.headers);
  assert.deepEqual(dialArgs('ws://h:3040/termag/ws/agent', 't', { tokenInQuery: true }).options, {});
});

test("only the old orchestrators' exact refusal triggers the query form", () => {
  assert.equal(refusedForWantOfQueryToken(1008, Buffer.from('token param required')), true);
  assert.equal(refusedForWantOfQueryToken(1008, 'authorization required'), false);
  assert.equal(refusedForWantOfQueryToken(1008, 'invalid or revoked token'), false);
  assert.equal(refusedForWantOfQueryToken(1006, 'token param required'), false);
});

test('a drain close redials within about a second, backing off when refused again', () => {
  const noJitter = () => 0;
  assert.equal(redialDelayMs(DRAIN_CLOSE_CODE, 1, 5, noJitter), 250);
  assert.equal(redialDelayMs(DRAIN_CLOSE_CODE, 2, 5, noJitter), 500);
  assert.equal(redialDelayMs(DRAIN_CLOSE_CODE, 9, 5, noJitter), 2000);
  assert.equal(redialDelayMs(DRAIN_CLOSE_CODE, 1, 5, () => 0.999), 749);
  assert.equal(redialDelayMs(DRAIN_CLOSE_CODE, 9, 1, noJitter), 1000, 'never past the normal interval');
});

test('any other close waits the configured interval', () => {
  assert.equal(redialDelayMs(1006, 0, 5), 5000);
  assert.equal(redialDelayMs(1001, 3, 5), 5000);
});
