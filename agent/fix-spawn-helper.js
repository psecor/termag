// postinstall: node-pty's prebuilt spawn-helper can be unpacked without its
// execute bit. node-pty then fails every spawn with "posix_spawnp failed" and
// leaks the pty it already opened, which used up kern.tty.ptmx_max within hours.
const fs = require('fs');
const path = require('path');

let ptyDir;
try {
  ptyDir = path.dirname(require.resolve('node-pty/package.json'));
} catch {
  process.exit(0);
}

const candidates = [path.join(ptyDir, 'build', 'Release', 'spawn-helper')];
const prebuilds = path.join(ptyDir, 'prebuilds');
if (fs.existsSync(prebuilds)) {
  for (const platform of fs.readdirSync(prebuilds)) {
    candidates.push(path.join(prebuilds, platform, 'spawn-helper'));
  }
}

for (const file of candidates) {
  try {
    const { mode } = fs.statSync(file);
    if ((mode & 0o111) !== 0o111) fs.chmodSync(file, mode | 0o755);
  } catch {
    // not present for this platform
  }
}
