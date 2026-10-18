import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above imports, so the mocks it references must be hoisted too.
const mocks = vi.hoisted(() => ({
  execFile: vi.fn((_file: string, _args: string[], cb: (e: null, out: string, err: string) => void) => cb(null, '', '')),
  exec: vi.fn((_cmd: string, cb: (e: null, out: string, err: string) => void) => cb(null, '', '')),
}));
vi.mock('child_process', () => ({ exec: mocks.exec, execFile: mocks.execFile }));

import { sendKeys, sendKeysArgv } from './tmux';

const AWKWARD = `psql -c "select 1 where name='psecor'" \\ $HOME \`x\` don't -n`;

describe('sendKeys (quotes must arrive verbatim)', () => {
  beforeEach(() => { mocks.execFile.mockClear(); mocks.exec.mockClear(); });

  it('builds argv with -l and -- and the untouched text', () => {
    expect(sendKeysArgv('u-p-ctrl', AWKWARD)).toEqual(['send-keys', '-t', 'u-p-ctrl', '-l', '--', AWKWARD]);
  });

  it('spawns tmux via execFile (no shell) and sends Enter as a separate call', async () => {
    await sendKeys('u-p-ctrl', AWKWARD);
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
    expect(mocks.execFile.mock.calls[0][0]).toBe('tmux');
    expect(mocks.execFile.mock.calls[0][1]).toEqual(['send-keys', '-t', 'u-p-ctrl', '-l', '--', AWKWARD]);
    expect(mocks.execFile.mock.calls[1][1]).toEqual(['send-keys', '-t', 'u-p-ctrl', 'Enter']);
  });

  it('withEnter=false types only', async () => {
    await sendKeys('s', "it's", false);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile.mock.calls[0][1]).toContain("it's");
  });
});
