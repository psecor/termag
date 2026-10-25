'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CAPABILITIES, FLAGS_MARKER, wrapperPath, wrapperSupportsFlags } = require('./claude-runner-wrapper');

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
