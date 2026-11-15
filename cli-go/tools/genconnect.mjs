// Golden fixtures for the Go port of the connect commands (ssh, attach, ssh-config, ssh-proxy):
// the pure functions of cli/src/connect/, run on representative inputs, written to
// cli-go/internal/cli/testdata/connect.json for connect_test.go.
//
// Usage (from the repo root, after `npm ci` in cli/): node cli-go/tools/genconnect.mjs [--out <dir>]
// `make -C cli-go generate` runs it after genspec.mjs. --out writes testdata/connect.json under
// <dir> instead of cli-go/internal/cli: TestGeneratedFilesMatchTheNodeCLI runs it that way, as it
// runs genspec.mjs, and fails on any difference.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const outAt = process.argv.indexOf('--out');
if (outAt >= 0 && !process.argv[outAt + 1]) throw new Error('--out needs a directory');
const outDir = outAt >= 0 ? resolve(process.argv[outAt + 1]) : join(repo, 'cli-go', 'internal', 'cli');
const cliDir = join(repo, 'cli');
const { build } = createRequire(join(cliDir, 'package.json'))('esbuild');

const out = join(cliDir, `.genconnect-${process.pid}.mjs`);
await build({
  stdin: {
    contents: [
      `export * from './connect/sshArgs.ts';`,
      `export { proxyCommandFor, sshHosts, renderBlock, upsertBlock, dropBlock } from './connect/sshConfig.ts';`,
      `export { renderAwsBlock, profileState, parseAwsCliVersion, supportsSsoSession } from './connect/awsConfig.ts';`,
      `export { withTerminfo, fallbackNotice } from './connect/terminfo.ts';`,
      `export { parseRef, pickBox, pickProxyBox, ssmTarget, wakeAction, boxFromAlias } from './connect/target.ts';`,
    ].join('\n'),
    resolveDir: join(cliDir, 'src'), sourcefile: 'connect-fixtures.ts', loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', packages: 'external', outfile: out, logLevel: 'warning', absWorkingDir: cliDir,
});
const m = await import(pathToFileURL(out).href);
rmSync(out, { force: true });
const attempt = (fn) => { try { return { ok: fn() }; } catch (err) { return { error: err.message, code: err.code }; } };

const route = { awsPath: '/usr/local/bin/aws', instanceId: 'i-0123456789abcdef0', region: 'us-east-2', profile: 'termag-boxes', document: 'TermagSSH' };
const oddRoute = { awsPath: '/Users/a b/100%/aws', instanceId: 'i-1', region: 'eu-west-1', profile: "it's", document: 'Doc%x' };
const plans = [
  { route, alias: 'termag-dev', user: 'ab', userOptions: [], remote: null, tty: false, batch: false },
  { route, alias: 'termag-dev', user: 'ab', userOptions: ['-N', '-L', '3000:localhost:3000'], remote: null, tty: false, batch: true },
  { route: oddRoute, alias: 'termag-dev', user: 'termag', userOptions: ['-v'], remote: "cd 'termag/projects/x' && make test", tty: true, batch: false },
];
// ec2InstanceId: valid ids go on HostName lines (#1704), 'i-1' isn't one; 'Dev' and 'dev' differ
// only in case, for pickBox's and pickProxyBox's case-blind matching.
const boxes = [
  { id: 'b1', name: 'dev', addressable: true, kind: 'ec2', state: 'running', hostUnixUser: 'termag', ec2InstanceId: 'i-0123456789abcdef0' },
  { id: 'b2', name: 'alpha', addressable: true, kind: 'ec2', state: 'running', hostUnixUser: null, ec2InstanceId: 'i-1' },
  { id: 'b3', name: 'bad name', addressable: false, kind: 'ec2', state: 'running' },
  { id: 'b4', name: 'Zed_box', addressable: true, kind: 'ec2', state: 'stopped', hostUnixUser: 'Bad User' },
  { id: 'b5', name: 'beta-2', addressable: true, kind: 'ec2', state: 'running', hostUnixUser: 'ab', ec2InstanceId: 'i-0aaaabbbbccccdddd' },
  { id: 'b6', name: 'Dev', addressable: true, kind: 'ec2', state: 'running', hostUnixUser: 'ab', ec2InstanceId: 'i-0fedcba9876543210' },
];
const projects = [
  { name: 'web', box: { id: 'b1', name: 'dev' }, sessions: { agent: 'ab-web-agent', ctrl: 'ab-web-ctrl' } },
  { name: 'API', box: { id: 'b1', name: 'dev' }, sessions: { agent: 'ab-API-agent', ctrl: 'ab-API-ctrl' } },
  { name: 'odd.name', box: { id: 'b2', name: 'alpha' }, sessions: { agent: 'x', ctrl: 'y' } },
  { name: 'nosess', box: { id: 'b2', name: 'alpha' }, sessions: null },
  { name: 'z', box: { id: 'b3', name: 'bad name' }, sessions: { agent: 'a', ctrl: 'c' } },
  { name: '_under', box: { id: 'b5', name: 'beta-2' }, sessions: { agent: 'a1', ctrl: 'c1' } },
];
const hosts = m.sshHosts('ab', boxes, projects);
const block = m.renderBlock({ proxyCommand: m.proxyCommandFor(['/home/ab/.local/bin/termag'], null), user: 'ab', ...hosts });
const nodeBlock = m.renderBlock({ proxyCommand: m.proxyCommandFor(['/usr/bin/node', '/home/ab/src/termag/cli/bin/termag.js'], null), user: 'ab' });
const SSH = { begin: '# >>> termag ssh-config >>>', end: '# <<< termag ssh-config <<<', file: '~/.ssh/config', command: 'termag ssh-config --install', at: 'top' };
const AWS = { begin: '# >>> termag aws-config >>>', end: '# <<< termag aws-config <<<', file: '~/.aws/config', command: 'termag ssh <box>', at: 'bottom' };
const upserts = [
  ['', SSH], ['Host *\n  ForwardAgent no\n', SSH], [`${nodeBlock}\n\nHost x\n  User y\n`, SSH], [`${block}\n\nHost x\n`, SSH],
  [`# >>> termag ssh-config >>>\nHost a\n`, SSH], [`${block}\n${block}\n`, SSH], [`# <<< termag ssh-config <<<\n# >>> termag ssh-config >>>\n`, SSH],
  ['[default]\nregion = us-west-2\n\n\n', AWS], ['', AWS],
];
const awsConfigs = [
  '', '[profile termag-boxes]\nsso_session = mine\n', '[profile termag-boxes]\nsso_start_url = https://x\nsso_region = us-east-1\n',
  '[profile other]\nregion = us-east-1\n', `${m.renderAwsBlock('termag-boxes')}\n`,
  `${m.renderAwsBlock('termag-boxes')}\n[sso-session termag]\nsso_start_url = x\n`, '[ profile   termag-boxes ]\n; comment\nSSO_SESSION=termag\n',
  '[termag-boxes]\n',
];

const fixtures = {
  shQuote: ['', 'plain', 'a b', "it's", 'x%y', '-dash', 'ünï', '$HOME'].map((input) => ({ input, ok: m.shQuote(input) })),
  remoteCommandLine: [[], ['make test | tail'], ['claude', '-p', 'fix the "test"'], ['a b', "c'd"]].map((input) => ({ input, ok: m.remoteCommandLine(input) })),
  scanSshOptions: [['-N', '-L', '3000:localhost:3000'], ['-NL', '1:a:1', '-v'], ['-o', 'X=y', 'stray', '-t'], ['--', 'x'], ['-L1:a:1', 'host']]
    .map((input) => { const r = m.scanSshOptions(input); return { input, flags: [...r.flags].sort(), stray: r.stray }; }),
  buildSshArgv: plans.map((plan) => ({ plan, ok: m.buildSshArgv(plan) })),
  proxyCommandFor: [
    [['/home/ab/.local/bin/termag'], null, false], [['/usr/bin/node', '/a b/termag.js'], 'https://x.example/termag', true], [['/p%q/termag'], 'http://h:1/t%x', false],
  ].map(([termag, host, wake]) => ({ termag, host, wake, ok: m.proxyCommandFor(termag, host, { wake }) })),
  sshHosts: { boxes, projects, user: 'ab', ok: hosts, block },
  upsertBlock: upserts.map(([existing, managed], i) => ({ existing, top: managed.at === 'top', block: managed === SSH ? (i === 2 ? block : block) : m.renderAwsBlock('p'), ...attempt(() => m.upsertBlock(existing, managed === SSH ? block : m.renderAwsBlock('p'), managed)) })),
  dropBlock: [[`[default]\n\n${m.renderAwsBlock('p')}\n`, AWS], [`${m.renderAwsBlock('p')}\n\n[x]\n`, AWS], ['nothing', AWS]].map(([existing, managed]) => ({ existing, ok: m.dropBlock(existing, managed) })),
  awsBlock: m.renderAwsBlock('termag-boxes'),
  profileState: awsConfigs.map((content) => ({ content, ok: m.profileState(content, 'termag-boxes') })),
  awsVersion: ['aws-cli/2.15.30 Python/3.11.8 Darwin/23.4.0', 'aws-cli/2.8.1', 'aws-cli/1.33.0', 'nope'].map((input) => {
    const v = m.parseAwsCliVersion(input); return { input, version: v, supports: v ? m.supportsSsoSession(v) : null };
  }),
  withTerminfo: { ok: m.withTerminfo('xterm-ghostty', 'xterm-ghostty|ghostty,\n\tam, bce,\n', 'exec "${SHELL:-/bin/sh}" -l') },
  fallbackNotice: m.fallbackNotice({ kind: 'fallback', term: 'weird', reason: 'because' }),
  parseRef: ['dev', 'dev/web', '', 'a/b/c', '/x', 'x/'].map((input) => ({ input, ...attempt(() => m.parseRef(input || undefined)) })),
  ssmTarget: ['running', 'unknown', 'stopped', 'stopping', 'hibernated', 'hibernating', 'failed', 'starting'].map((state) => ({
    state, ...attempt(() => m.ssmTarget({ name: 'dev', kind: 'ec2', ec2InstanceId: 'i-1', region: null, state, error: state === 'failed' ? 'boom' : null }, 'us-east-2')),
  })).concat([{ state: 'external', ...attempt(() => m.ssmTarget({ name: 'dev', kind: 'external', state: 'running' }, 'us-east-2')) }]),
  pickBox: [['dev', boxes], ['b2', boxes], ['nope', boxes], [null, boxes], [null, boxes.slice(0, 1)], [null, []], ['x', []],
    ['Dev', boxes], ['DEV', boxes], ['ALPHA', boxes], ['dev', boxes, true], ['beta-2', boxes, true], ['b1', boxes, true]]
    .map(([name, list, caseLost]) => ({ name, n: list.length, caseLost: !!caseLost, ...attempt(() => m.pickBox(list, name, { caseLost: !!caseLost }).id) })),
  pickProxyBox: ['i-0123456789abcdef0', 'I-0123456789ABCDEF0', 'i-0fedcba9876543210', 'i-00000000', 'i-1', 'termag-dev', 'termag-alpha',
    'termag-beta-2', 'termag-nope', 'dev', 'termag-']
    .map((host) => ({ host, ...attempt(() => m.pickProxyBox(boxes, host).id) })),
  boxFromAlias: ['termag-dev', 'termag-', 'dev'].map((input) => ({ input, ...attempt(() => m.boxFromAlias(input)) })),
};
mkdirSync(join(outDir, 'testdata'), { recursive: true });
writeFileSync(join(outDir, 'testdata', 'connect.json'), JSON.stringify(fixtures, null, 2) + '\n');
console.log('wrote testdata/connect.json');
void readFileSync;
