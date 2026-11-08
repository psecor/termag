'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupFile, setupOff } = require('./box-setup');

test('setupOff: no file is setup on', () => {
  assert.strictEqual(setupOff(path.join(os.tmpdir(), 'termag-no-such-setup')), false);
});

test('setupOff: true only when the first line says off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-box-setup-'));
  const file = path.join(dir, 'setup');
  try {
    fs.writeFileSync(file, 'off\n');
    assert.strictEqual(setupOff(file), true);
    fs.writeFileSync(file, ' off \nmore\n');
    assert.strictEqual(setupOff(file), true);
    fs.writeFileSync(file, 'offish\n');
    assert.strictEqual(setupOff(file), false);
    fs.writeFileSync(file, 'on\n');
    assert.strictEqual(setupOff(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setupFile: TERMAG_SETUP_FILE overrides the home path', () => {
  assert.strictEqual(setupFile({ TERMAG_SETUP_FILE: '/x/setup' }), '/x/setup');
  assert.strictEqual(setupFile({}), path.join(os.homedir(), '.config', 'termag', 'setup'));
});
