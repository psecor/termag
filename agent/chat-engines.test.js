'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ENGINE_SPECS, ENGINE_IDS, engineSpec, engineTag, isEngineId } = require('./chat-engines');
const { engineOf } = require('./chat-runner');
const { agentLabel, agentSignals, reportedExit, stateRecord } = require('./chat-turn');

const KEYS = [
  'id', 'label', 'claudeCode', 'liveInput', 'images', 'sessionMadeBy', 'signals', 'stopReadsAsInterrupt',
  'canClear', 'canCompact', 'pagesHistory', 'subagents', 'titles', 'paneResume', 'createNormalizer', 'rawLog', 'runnerTranscript',
  'resumeKeepsId',
];

test('every engine says everything the runner and the wrapper ask of it, under its own id', () => {
  assert.deepStrictEqual(ENGINE_IDS, ['claude', 'pi', 'cursor', 'devin']);
  for (const id of ENGINE_IDS) {
    const spec = ENGINE_SPECS[id];
    assert.deepStrictEqual(Object.keys(spec).sort(), [...KEYS].sort(), id);
    assert.strictEqual(spec.id, id);
    assert.ok(['engine', 'runner'].includes(spec.sessionMadeBy), id);
    assert.deepStrictEqual(Object.keys(spec.signals).sort(), ['group', 'interrupt', 'stop'], id);
    // A stream that isn't Claude's is piped through its normaliser and kept as the agent wrote it.
    assert.strictEqual(typeof spec.createNormalizer === 'function', Boolean(spec.rawLog), id);
    assert.strictEqual(spec.claudeCode, spec.createNormalizer === null, id);
  }
  // Only Claude Code has live input and images.
  assert.deepStrictEqual(ENGINE_IDS.filter(id => ENGINE_SPECS[id].liveInput), ['claude']);
  assert.deepStrictEqual(ENGINE_IDS.filter(id => ENGINE_SPECS[id].images), ['claude']);
});

test("anything that isn't an engine id is Claude's: none, an older record's, one this agent doesn't know", () => {
  for (const v of [undefined, null, '', 'codex', 'Claude', 42, {}]) {
    assert.strictEqual(engineSpec(v).id, 'claude');
    assert.strictEqual(isEngineId(v), false);
    assert.deepStrictEqual(engineTag(v), {});
  }
  assert.deepStrictEqual(engineTag('claude'), {});
  assert.deepStrictEqual(engineTag('pi'), { engine: 'pi' });
  assert.deepStrictEqual(engineTag('cursor'), { engine: 'cursor' });
  assert.deepStrictEqual(engineTag('devin'), { engine: 'devin' });
});

test("a send's engine is one of the table's, or refused rather than run on Claude", () => {
  assert.strictEqual(engineOf({}), 'claude');
  assert.strictEqual(engineOf({ engine: 'pi' }), 'pi');
  assert.strictEqual(engineOf({ engine: 'cursor' }), 'cursor');
  assert.strictEqual(engineOf({ engine: 'devin' }), 'devin');
  assert.throws(() => engineOf({ engine: 'codex' }), /engine-refused/);
});

test("the wrapper reads its label, signals, stop exit and state record off the table, as it did off 'pi'", () => {
  assert.strictEqual(agentLabel('pi'), 'pi');
  assert.strictEqual(agentLabel(undefined), 'Claude');
  assert.deepStrictEqual(agentSignals('pi'), { group: true, stop: 'SIGTERM', interrupt: 'SIGTERM' });
  assert.deepStrictEqual(agentSignals('claude'), { group: false, stop: 'SIGTERM', interrupt: 'SIGINT' });
  assert.deepStrictEqual(reportedExit({ code: 143, signal: null, interrupted: true, engine: 'pi' }), { code: null, signal: 'SIGINT' });
  assert.deepStrictEqual(reportedExit({ code: 143, signal: null, interrupted: true, engine: 'claude' }), { code: 143, signal: null });
  const at = new Date('2026-11-12T00:00:00Z');
  assert.deepStrictEqual(stateRecord('s', { cwd: '/w', engine: 'pi' }, at), { sessionId: 's', cwd: '/w', engine: 'pi', updatedAt: at.toISOString() });
  assert.deepStrictEqual(stateRecord('s', { cwd: '/w' }, at), { sessionId: 's', cwd: '/w', updatedAt: at.toISOString() });
});

test("only an engine whose own store can't be read has the runner keep its transcript", () => {
  assert.deepStrictEqual(ENGINE_IDS.filter(id => ENGINE_SPECS[id].runnerTranscript), ['cursor', 'devin']);
  assert.strictEqual(engineSpec('devin').sessionMadeBy, 'engine');
  assert.deepStrictEqual(agentSignals('devin'), { group: true, stop: 'SIGTERM', interrupt: 'SIGTERM' });
  assert.strictEqual(agentLabel('devin'), 'Devin');
  assert.strictEqual(engineSpec('cursor').sessionMadeBy, 'engine');
  assert.deepStrictEqual(agentSignals('cursor'), { group: true, stop: 'SIGTERM', interrupt: 'SIGTERM' });
});

test('only Devin may start a new session when asked to go on in one (a load that failed)', () => {
  assert.deepStrictEqual(ENGINE_IDS.filter(id => !ENGINE_SPECS[id].resumeKeepsId), ['devin']);
});
