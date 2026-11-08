'use strict';
// Whether termag setup is off on this box, from the file
// cloud-init writes when it is (`off`); backend services/boxSetup.ts and
// deploy/termag-reconcile use the same path. Read on each call: it is one
// small file and changes at most once.

const fs = require('fs');
const os = require('os');
const path = require('path');

function setupFile(env = process.env) {
  return env.TERMAG_SETUP_FILE || path.join(os.homedir(), '.config', 'termag', 'setup');
}

/** True when the file's first line says `off`; no file is setup on. */
function setupOff(file = setupFile()) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')[0].trim() === 'off';
  } catch {
    return false;
  }
}

module.exports = { setupFile, setupOff };
