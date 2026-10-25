'use strict';
/**
 * The `write-file` RPC: write `content` to `p`, creating its directory.
 *
 * `mode` (optional) is the file's permissions, applied before any content
 * lands (the Claude runner's work order is written 0600). `dirMode` (optional)
 * is applied to the file's own directory, new or existing: sshd's StrictModes
 * refuses an authorized_keys whose ~/.ssh is group-writable, and a directory
 * made here otherwise gets the agent's umask (002 on a box).
 */
const fs = require('node:fs');
const path = require('node:path');

const validMode = (m) => (Number.isInteger(m) && m >= 0 && m <= 0o777 ? m : null);

/**
 * @param {string} p
 * @param {string} content
 * @param {{ mode?: unknown, dirMode?: unknown }} [opts]
 */
async function writeFileRpc(p, content, opts = {}) {
  if (typeof content !== 'string') throw new Error('write-file: content must be a string');
  const fsp = fs.promises;
  const mode = validMode(opts.mode);
  const dirMode = validMode(opts.dirMode);
  const dir = path.dirname(p);
  await fsp.mkdir(dir, { recursive: true });
  if (dirMode !== null) await fsp.chmod(dir, dirMode);
  if (mode !== null) {
    await fsp.writeFile(p, '', { flag: 'a', mode });
    await fsp.chmod(p, mode);
  }
  await fsp.writeFile(p, content, 'utf8');
}

module.exports = { writeFileRpc };
