import { describe, expect, it } from 'vitest';
import { parseCommandLine } from './args.js';
import type { Ctx } from './context.js';
import { CliError } from './errors.js';
import { tuiNodeHint } from './tui.js';
import { nodeOnPath, runUpdate, updatePlan, type UpdateDeps } from './update.js';

const CHECKOUT = '/home/alice/src/termag';

function ctx(env: NodeJS.ProcessEnv, out: string[] = [], err: string[] = []): Ctx {
  return {
    env, home: '/home/alice', hostname: 'mbp', interactive: true,
    out: (t) => { out.push(t); }, err: (t) => { err.push(t); },
    fetch: globalThis.fetch, openBrowser: () => {}, readFile: () => null,
  };
}

function deps(overrides: Partial<UpdateDeps> = {}, ran: Array<[string, string[]]> = []): UpdateDeps {
  return {
    defaultCheckout: '/opt/elsewhere',
    execPath: '/opt/node/bin/node',
    run: async (cmd, args) => { ran.push([cmd, args]); return 0; },
    currentBranch: async () => 'main',
    nodeVersion: async () => '22.14.0',
    exists: (p) => p.endsWith('/cli/install.sh') || p === '/usr/bin/node',
    writable: () => true,
    ...overrides,
  };
}

describe('termag update', () => {
  it('parses --no-pull and nothing else', () => {
    expect(parseCommandLine(['update'])).toMatchObject({ command: 'update', options: {} });
    expect(parseCommandLine(['update', '--no-pull'])).toMatchObject({ options: { 'no-pull': true } });
    expect(() => parseCommandLine(['update', 'now'])).toThrow(CliError);
  });

  it('pulls, then reinstalls into the launcher\'s own directory', () => {
    const plan = updatePlan(
      { TERMAG_CLI_CHECKOUT: CHECKOUT, TERMAG_CLI_BIN: '/home/alice/bin/termag', PATH: '/usr/bin' },
      deps(), true);
    expect(plan.steps).toEqual([
      { cmd: 'git', args: ['-C', CHECKOUT, 'pull', '--ff-only'] },
      { cmd: 'sh', args: [`${CHECKOUT}/cli/install.sh`, '--bin-dir', '/home/alice/bin'] },
    ]);
  });

  it('without the launcher, uses the checkout it runs from', () => {
    const plan = updatePlan({ PATH: '/usr/bin' }, deps(), false);
    expect(plan.steps).toEqual([{ cmd: 'sh', args: ['/opt/elsewhere/cli/install.sh'] }]);
  });

  it('keeps the running Node when PATH has none', () => {
    expect(nodeOnPath({ PATH: '/usr/bin' }, deps().exists)).toBe(true);
    const plan = updatePlan({ TERMAG_CLI_CHECKOUT: CHECKOUT, PATH: '/bin' }, deps(), false);
    expect(plan.steps.at(-1)!.args).toEqual([`${CHECKOUT}/cli/install.sh`, '--node', '/opt/node/bin/node']);
  });

  it('runs the steps in order and reports JSON', async () => {
    const ran: Array<[string, string[]]> = [];
    const out: string[] = [];
    const code = await runUpdate(ctx({ TERMAG_CLI_CHECKOUT: CHECKOUT, PATH: '/usr/bin' }, out),
      parseCommandLine(['update', '--json']), deps({}, ran));
    expect(code).toBe(0);
    expect(ran.map(([cmd]) => cmd)).toEqual(['git', 'sh']);
    expect(JSON.parse(out[0])).toEqual({ updated: true, checkout: CHECKOUT, pulled: true, branch: 'main', tui: 'not-built' });
  });

  it('stops at a failed pull', async () => {
    const ran: Array<[string, string[]]> = [];
    const d = deps({ run: async (cmd, args) => { ran.push([cmd, args]); return cmd === 'git' ? 128 : 0; } });
    await expect(runUpdate(ctx({ TERMAG_CLI_CHECKOUT: CHECKOUT, PATH: '/usr/bin' }), parseCommandLine(['update']), d))
      .rejects.toThrow(/git -C .* exited 128/);
    expect(ran).toHaveLength(1);
  });

  it('refuses a checkout without the installer or one the user cannot write', async () => {
    const env = { TERMAG_CLI_CHECKOUT: '/opt/termag', PATH: '/usr/bin' };
    await expect(runUpdate(ctx(env), parseCommandLine(['update']), deps({ exists: () => false })))
      .rejects.toThrow(/has no cli\/install\.sh/);
    await expect(runUpdate(ctx(env), parseCommandLine(['update']), deps({ writable: () => false })))
      .rejects.toThrow(/image owns it/);
  });

  it('pulls main without a word', async () => {
    const err: string[] = [];
    await runUpdate(ctx({ TERMAG_CLI_CHECKOUT: CHECKOUT, PATH: '/usr/bin' }, [], err), parseCommandLine(['update']), deps());
    expect(err).toEqual([]);
  });

  it('on another branch, warns once naming it and pulls that branch without switching', async () => {
    const ran: Array<[string, string[]]> = [];
    const out: string[] = [];
    const err: string[] = [];
    const code = await runUpdate(ctx({ TERMAG_CLI_CHECKOUT: CHECKOUT, PATH: '/usr/bin' }, out, err),
      parseCommandLine(['update', '--json']), deps({ currentBranch: async () => 'zane/cli-m1' }, ran));
    expect(code).toBe(0);
    expect(err).toEqual([`termag update: warning: ${CHECKOUT} is on branch \`zane/cli-m1\`, not \`main\`; pulling \`zane/cli-m1\``]);
    expect(ran[0]).toEqual(['git', ['-C', CHECKOUT, 'pull', '--ff-only']]);
    expect(ran.flatMap(([, a]) => a)).not.toContain('checkout');
    expect(ran.flatMap(([, a]) => a)).not.toContain('switch');
    expect(JSON.parse(out[0])).toMatchObject({ pulled: true, branch: 'zane/cli-m1' });
  });

  it('refuses to pull a detached HEAD, and --no-pull never asks', async () => {
    const ran: Array<[string, string[]]> = [];
    const env = { TERMAG_CLI_CHECKOUT: CHECKOUT, PATH: '/usr/bin' };
    await expect(runUpdate(ctx(env), parseCommandLine(['update']), deps({ currentBranch: async () => null }, ran)))
      .rejects.toThrow(/detached HEAD/);
    expect(ran).toEqual([]);
    const err: string[] = [];
    let asked = false;
    await runUpdate(ctx(env, [], err), parseCommandLine(['update', '--no-pull']),
      deps({ currentBranch: async () => { asked = true; return 'feature'; } }));
    expect(asked).toBe(false);
    expect(err).toEqual([]);
  });

  describe('the TUI', () => {
    const env = { TERMAG_CLI_CHECKOUT: CHECKOUT, PATH: '/usr/bin' };
    const built = (p: string) => p.endsWith('/cli/install.sh') || p.endsWith('/tui/install.sh')
      || p === `${CHECKOUT}/tui/dist/index.js` || p === '/usr/bin/node';

    it('is left alone when it was never built', async () => {
      const ran: Array<[string, string[]]> = [];
      const err: string[] = [];
      await runUpdate(ctx(env, [], err), parseCommandLine(['update', '--no-pull']), deps({}, ran));
      expect(ran.map(([, a]) => a[0])).toEqual([`${CHECKOUT}/cli/install.sh`]);
      expect(err).toEqual([]);
    });

    it('is rebuilt after the CLI when it was built', async () => {
      const ran: Array<[string, string[]]> = [];
      const out: string[] = [];
      await runUpdate(ctx(env, out), parseCommandLine(['update', '--json']), deps({ exists: built }, ran));
      expect(ran).toEqual([
        ['git', ['-C', CHECKOUT, 'pull', '--ff-only']],
        ['sh', [`${CHECKOUT}/cli/install.sh`]],
        ['sh', [`${CHECKOUT}/tui/install.sh`, '--quiet']],
      ]);
      expect(JSON.parse(out[0])).toMatchObject({ tui: 'rebuilt' });
    });

    it('is rebuilt with the running Node when PATH has none', async () => {
      const ran: Array<[string, string[]]> = [];
      const asked: string[] = [];
      const exists = (p: string) => built(p) && p !== '/usr/bin/node';
      await runUpdate(ctx(env), parseCommandLine(['update', '--no-pull']),
        deps({ exists, nodeVersion: async (n) => { asked.push(n); return '22.1.0'; } }, ran));
      expect(asked).toEqual(['/opt/node/bin/node']);
      expect(ran.at(-1)).toEqual(['sh', [`${CHECKOUT}/tui/install.sh`, '--quiet', '--node', '/opt/node/bin/node']]);
    });

    it('with a Node older than 22, prints the hint and the update still succeeds', async () => {
      const ran: Array<[string, string[]]> = [];
      const out: string[] = [];
      const err: string[] = [];
      const code = await runUpdate(ctx(env, out, err), parseCommandLine(['update', '--no-pull', '--json']),
        deps({ exists: built, nodeVersion: async () => '20.11.1' }, ran));
      expect(code).toBe(0);
      expect(ran.map(([, a]) => a[0])).toEqual([`${CHECKOUT}/cli/install.sh`]);
      expect(err).toEqual([`termag update: the TUI was not rebuilt. ${tuiNodeHint('20.11.1', CHECKOUT)}`]);
      expect(err[0]).toContain(`make -C ${CHECKOUT} install-cli`);
      expect(JSON.parse(out[0])).toMatchObject({ updated: true, tui: 'node-too-old' });
    });

    it('fails the update when its build fails', async () => {
      const d = deps({ exists: built, run: async (_c, a) => (a[0].endsWith('/tui/install.sh') ? 1 : 0) });
      await expect(runUpdate(ctx(env), parseCommandLine(['update', '--no-pull']), d)).rejects.toThrow(/tui\/install\.sh .*exited 1/);
    });
  });
});
