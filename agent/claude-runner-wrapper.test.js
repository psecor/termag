'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CAPABILITIES, FLOOR_CAPABILITY, FLAGS_MARKER, wrapperPath, flagWords, wrapperSupportsFlags, wrapperCapabilities } = require('./claude-runner-wrapper');

test('the agent announces the wrapper-flags capability', () => {
  assert.deepEqual(CAPABILITIES, ['claude-runner-wrapper-v2']);
});

test('the wrapper is looked for where termag-reconcile installs it', () => {
  assert.equal(wrapperPath('/home/ada'), '/home/ada/.local/bin/termag-claude-runner');
});

test('a wrapper with the marker supports the flags; one without, or none, does not', () => {
  const withMarker = () => `#!/usr/bin/env bash\n# ${FLAGS_MARKER}\necho hi\n`;
  const without = () => '#!/usr/bin/env bash\necho hi\n';
  const missing = () => { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; };
  assert.equal(wrapperSupportsFlags(withMarker, '/home/ada'), true);
  assert.equal(wrapperSupportsFlags(without, '/home/ada'), false);
  assert.equal(wrapperSupportsFlags(missing, '/home/ada'), false);
});

test('the shipped wrapper carries the marker the agent looks for', () => {
  const shipped = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'termag-claude-runner'), 'utf8');
  assert.ok(shipped.includes(FLAGS_MARKER), 'deploy/termag-claude-runner must keep the flags marker line');
  assert.equal(wrapperSupportsFlags(() => shipped, '/home/ada'), true);
});

test('v3 is announced for a wrapper whose flags line has claude-floor, v2 still for the git flags', () => {
  assert.equal(FLOOR_CAPABILITY, 'claude-runner-wrapper-v3');
  const v3 = () => '#!/usr/bin/env bash\n# termag-claude-runner-flags: anthropic-git github claude-floor\n';
  const v2 = () => '#!/usr/bin/env bash\n# termag-claude-runner-flags: anthropic-git github\n';
  const none = () => '#!/usr/bin/env bash\necho hi\n';
  // The word elsewhere in the file (a comment, a usage line) is not the flags line.
  const elsewhere = () => '#!/usr/bin/env bash\n# termag-claude-runner-flags: anthropic-git github\n# usage: --claude-floor <x.y.z>\n';
  const missing = () => { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; };
  assert.deepEqual(wrapperCapabilities(v3, '/home/ada'), ['claude-runner-wrapper-v2', 'claude-runner-wrapper-v3']);
  assert.deepEqual(wrapperCapabilities(v2, '/home/ada'), ['claude-runner-wrapper-v2']);
  assert.deepEqual(wrapperCapabilities(elsewhere, '/home/ada'), ['claude-runner-wrapper-v2']);
  assert.deepEqual(wrapperCapabilities(none, '/home/ada'), []);
  assert.deepEqual(wrapperCapabilities(missing, '/home/ada'), []);
  assert.equal(wrapperSupportsFlags(v3, '/home/ada'), true, 'the v2 marker is a prefix of the v3 line');
  assert.deepEqual(flagWords('x\n# termag-claude-runner-flags: a  b\tc\ny'), ['a', 'b', 'c']);
  assert.deepEqual(flagWords('nothing'), []);
});

test('the shipped wrapper announces both v2 and v3', () => {
  const shipped = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'termag-claude-runner'), 'utf8');
  assert.deepEqual(wrapperCapabilities(() => shipped, '/home/ada'), [...CAPABILITIES, FLOOR_CAPABILITY]);
});
