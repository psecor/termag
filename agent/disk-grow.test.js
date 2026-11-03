'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseFindmnt, growpartOutcome, fsGrowArgv, parseDfSizeGb, growRootDisk } = require('./disk-grow');

test('parseFindmnt reads the source and file system, and refuses anything that is not a device', () => {
  assert.deepStrictEqual(parseFindmnt('/dev/nvme0n1p1 ext4\n'), { source: '/dev/nvme0n1p1', fstype: 'ext4' });
  assert.strictEqual(parseFindmnt('overlay overlay'), null);
  assert.strictEqual(parseFindmnt(''), null);
});

test('growpartOutcome treats NOCHANGE as unchanged, not failed', () => {
  assert.strictEqual(growpartOutcome(0, 'CHANGED: partition=1'), 'grown');
  assert.strictEqual(growpartOutcome(1, 'NOCHANGE: partition 1 is size 251656159. it cannot be grown'), 'unchanged');
  assert.strictEqual(growpartOutcome(1, ''), 'failed');
  assert.strictEqual(growpartOutcome(2, 'FAILED'), 'failed');
});

test('fsGrowArgv picks the tool per file system and refuses the rest', () => {
  assert.deepStrictEqual(fsGrowArgv('ext4', '/dev/nvme0n1p1'), ['-n', 'resize2fs', '/dev/nvme0n1p1']);
  assert.deepStrictEqual(fsGrowArgv('xfs', '/dev/nvme0n1p1'), ['-n', 'xfs_growfs', '/']);
  assert.strictEqual(fsGrowArgv('btrfs', '/dev/nvme0n1p1'), null);
});

test('parseDfSizeGb reads the 1024-blocks column', () => {
  const df = 'Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/root       154894020 130000000  24894020      84% /\n';
  assert.strictEqual(parseDfSizeGb(df), 148);
  assert.strictEqual(parseDfSizeGb('garbage'), null);
});

function fakeExec(replies) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const r = replies[cmd === 'sudo' ? args[1] : cmd];
    const reply = typeof r === 'function' ? r() : r;
    if (reply.code) throw Object.assign(new Error('exit'), reply);
    return reply;
  };
  return { exec, calls };
}
const target = { diskAndPartition: () => ({ disk: '/dev/nvme0n1', partition: '1' }) };
const DF_HEAD = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n';

test('growRootDisk runs growpart then resize2fs with sudo -n and reports the sizes', async () => {
  let dfCalls = 0;
  const { exec, calls } = fakeExec({
    findmnt: { stdout: '/dev/nvme0n1p1 ext4\n', stderr: '' },
    df: () => ({ stdout: `${DF_HEAD}/dev/root ${++dfCalls === 1 ? 154894020 : 311000000} 1 1 50% /\n`, stderr: '' }),
    growpart: { stdout: 'CHANGED', stderr: '' },
    resize2fs: { stdout: '', stderr: '' },
  });
  const r = await growRootDisk(exec, target);
  assert.deepStrictEqual(r, { ok: true, device: '/dev/nvme0n1p1', fstype: 'ext4', partition: 'grown', beforeGb: 148, afterGb: 297 });
  assert.deepStrictEqual(calls.filter(c => c.startsWith('sudo')), ['sudo -n growpart /dev/nvme0n1 1', 'sudo -n resize2fs /dev/nvme0n1p1']);
});

test('growRootDisk still grows the file system when the partition already fills the disk', async () => {
  const { exec, calls } = fakeExec({
    findmnt: { stdout: '/dev/nvme0n1p1 ext4', stderr: '' },
    df: { stdout: `${DF_HEAD}/dev/root 154894020 1 1 50% /\n`, stderr: '' },
    growpart: { code: 1, stdout: 'NOCHANGE: partition 1 is size 1. it cannot be grown', stderr: '' },
    resize2fs: { stdout: '', stderr: '' },
  });
  const r = await growRootDisk(exec, target);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.partition, 'unchanged');
  assert.ok(calls.includes('sudo -n resize2fs /dev/nvme0n1p1'));
});

test('growRootDisk reports a failed step without throwing, and stops there', async () => {
  const { exec, calls } = fakeExec({
    findmnt: { stdout: '/dev/nvme0n1p1 ext4', stderr: '' },
    df: { stdout: `${DF_HEAD}/dev/root 154894020 1 1 50% /\n`, stderr: '' },
    growpart: { code: 2, stdout: '', stderr: 'FAILED: disk not found' },
  });
  const r = await growRootDisk(exec, target);
  assert.deepStrictEqual(r, { ok: false, error: 'growpart: FAILED: disk not found', beforeGb: 148 });
  assert.ok(!calls.some(c => c.includes('resize2fs')));
});

test('growRootDisk refuses a file system it does not know how to grow', async () => {
  const { exec } = fakeExec({ findmnt: { stdout: '/dev/nvme0n1p1 btrfs', stderr: '' }, df: { stdout: '', stderr: '' } });
  assert.deepStrictEqual(await growRootDisk(exec, target), { ok: false, error: 'unsupported root file system btrfs' });
});
