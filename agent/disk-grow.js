'use strict';
/**
 * Grow the root partition and file system into a root EBS volume the
 * orchestrator just made larger (the admin "grow disk" action).
 * Answers the `disk-grow` RPC once the volume
 * modification is `optimizing`. The request carries no command: the steps are
 * fixed here, run with the box's passwordless sudo (packer/scripts/setup.sh).
 *
 *   findmnt /           → the root partition and its file system
 *   growpart <disk> <n> → the partition fills the disk (NOCHANGE when it already does)
 *   resize2fs / xfs_growfs → the file system fills the partition
 *
 * Linux only. The parsers are pure and tested.
 */
const fs = require('fs');
const path = require('path');

const CAPABILITIES = ['disk-grow-v1'];
const STEP_TIMEOUT_MS = 120_000;

/** `findmnt -no SOURCE,FSTYPE /` → { source, fstype }, or null. */
function parseFindmnt(text) {
  const cols = (text || '').trim().split(/\s+/);
  if (cols.length < 2 || !cols[0].startsWith('/dev/')) return null;
  return { source: cols[0], fstype: cols[1] };
}

/** growpart exits 1 and prints NOCHANGE when the partition already fills the disk; that is not a failure. */
function growpartOutcome(code, stdout) {
  if (code === 0) return 'grown';
  if (code === 1 && /NOCHANGE/.test(stdout || '')) return 'unchanged';
  return 'failed';
}

/** The sudo argv that grows a file system of this type, or null for one we don't grow. */
function fsGrowArgv(fstype, source) {
  if (fstype === 'ext4' || fstype === 'ext3' || fstype === 'ext2') return ['-n', 'resize2fs', source];
  if (fstype === 'xfs') return ['-n', 'xfs_growfs', '/'];
  return null;
}

/** Size in GB of the file system `df -Pk /` describes (its 1024-blocks column), or null. */
function parseDfSizeGb(text) {
  const lines = (text || '').trim().split('\n');
  if (lines.length < 2) return null;
  const cols = lines[lines.length - 1].trim().split(/\s+/);
  const kb = Number(cols[1]);
  return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024 / 1024) : null;
}

/** The whole disk and partition number for a partition device, from sysfs. */
function diskAndPartition(source, sysBlock = '/sys/class/block') {
  const name = path.basename(fs.realpathSync(source));
  const partition = fs.readFileSync(path.join(sysBlock, name, 'partition'), 'utf8').trim();
  // /sys/class/block/<part> links into .../<disk>/<part>, so the parent directory is the disk.
  const disk = path.basename(path.dirname(fs.realpathSync(path.join(sysBlock, name))));
  return { disk: `/dev/${disk}`, partition };
}

async function run(execFileAsync, cmd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: STEP_TIMEOUT_MS });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : -1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? err.message) };
  }
}

/** Grow `/` into its disk. Resolves to { ok, ... } and never throws. */
async function growRootDisk(execFileAsync, deps = { diskAndPartition }) {
  const df = async () => parseDfSizeGb((await run(execFileAsync, 'df', ['-Pk', '/'])).stdout);
  const mount = parseFindmnt((await run(execFileAsync, 'findmnt', ['-no', 'SOURCE,FSTYPE', '/'])).stdout);
  if (!mount) return { ok: false, error: 'could not read the root mount' };
  const growArgv = fsGrowArgv(mount.fstype, mount.source);
  if (!growArgv) return { ok: false, error: `unsupported root file system ${mount.fstype}` };
  let target;
  try { target = deps.diskAndPartition(mount.source); } catch (err) { return { ok: false, error: `no partition for ${mount.source}: ${err.message}` }; }

  const beforeGb = await df();
  const gp = await run(execFileAsync, 'sudo', ['-n', 'growpart', target.disk, target.partition]);
  const partition = growpartOutcome(gp.code, gp.stdout);
  if (partition === 'failed') return { ok: false, error: `growpart: ${(gp.stderr || gp.stdout).trim().slice(0, 500)}`, beforeGb };
  const fsr = await run(execFileAsync, 'sudo', growArgv);
  if (fsr.code !== 0) return { ok: false, error: `${growArgv[1]}: ${(fsr.stderr || fsr.stdout).trim().slice(0, 500)}`, beforeGb };
  return { ok: true, device: mount.source, fstype: mount.fstype, partition, beforeGb, afterGb: await df() };
}

module.exports = { CAPABILITIES, parseFindmnt, growpartOutcome, fsGrowArgv, parseDfSizeGb, diskAndPartition, growRootDisk };
