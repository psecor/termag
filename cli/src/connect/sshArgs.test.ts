import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  buildSshArgv, inDirectory, remoteCommandLine, scanSshOptions, shQuote, splitAtDoubleDash, ssmProxyCommand,
} from './sshArgs.js';

const route = { awsPath: '/usr/local/bin/aws', instanceId: 'i-0abc', region: 'us-east-2', profile: 'termag-boxes', document: 'TermagSSH' };

describe('shQuote', () => {
  it('leaves plain words alone and quotes the rest so sh reads them back unchanged', () => {
    expect(shQuote('portNumber=22')).toBe('portNumber=22');
    for (const word of ['fix the test', "it's", '', '$HOME', 'a;b', '"q"', 'x\ny']) {
      expect(execFileSync('sh', ['-c', `printf %s ${shQuote(word)}`], { encoding: 'utf8' })).toBe(word);
    }
  });
});

describe('remoteCommandLine', () => {
  it('passes one argument through as a command line, like ssh', () => {
    expect(remoteCommandLine(['make test | tail -5'])).toBe('make test | tail -5');
  });

  it('quotes each of several words so they arrive intact', () => {
    expect(remoteCommandLine(['claude', '-p', 'fix the failing test'])).toBe("claude -p 'fix the failing test'");
  });

  it('is null with no command', () => {
    expect(remoteCommandLine([])).toBeNull();
  });
});

describe('scanSshOptions', () => {
  it('collects flags, skipping option values', () => {
    const s = scanSshOptions(['-N', '-L', '3000:localhost:3000', '-o', 'ServerAliveInterval=5', '-vT']);
    expect([...s.flags].sort()).toEqual(['L', 'N', 'T', 'o', 'v']);
    expect(s.stray).toEqual([]);
  });

  it('treats a value glued to its flag as part of it', () => {
    const s = scanSshOptions(['-NL3000:localhost:3000', '-i/tmp/key']);
    expect([...s.flags].sort()).toEqual(['L', 'N', 'i']);
  });

  it('reports words that are not options', () => {
    expect(scanSshOptions(['-N', 'ls']).stray).toEqual(['ls']);
  });
});

describe('splitAtDoubleDash', () => {
  it('splits options from the remote command', () => {
    expect(splitAtDoubleDash(['-A', '--', 'ls', '--', '-l'])).toEqual({ options: ['-A'], command: ['ls', '--', '-l'] });
    expect(splitAtDoubleDash(['-A'])).toEqual({ options: ['-A'], command: [] });
  });
});

describe('ssmProxyCommand', () => {
  it('is the ProxyCommand USAGE.md documents, with ssh expanding only %p', () => {
    expect(ssmProxyCommand(route)).toBe(
      '/usr/local/bin/aws ssm start-session --target i-0abc --document-name TermagSSH --parameters portNumber=%p --region us-east-2 --profile termag-boxes');
    expect(ssmProxyCommand({ ...route, awsPath: '/opt/100%/aws' })).toContain('/opt/100%%/aws');
  });
});

describe('buildSshArgv', () => {
  const plan = { route, alias: 'termag-devbox', user: 'alice', userOptions: [], remote: null, tty: false, batch: false };

  it('routes through SSM, files the host key under the instance id and logs in as the box user', () => {
    const argv = buildSshArgv(plan);
    expect(argv.at(-1)).toBe('termag-devbox');
    expect(argv).toContain(`ProxyCommand=${ssmProxyCommand(route)}`);
    expect(argv).toContain('HostKeyAlias=i-0abc');
    expect(argv).toContain('User=alice');
    expect(argv).not.toContain('-t');
    expect(argv).not.toContain('BatchMode=yes');
  });

  it('puts the user\'s options first, so they win, and the remote command last', () => {
    const argv = buildSshArgv({ ...plan, userOptions: ['-o', 'User=bob', '-N'], remote: 'ls', tty: true, batch: true });
    expect(argv.slice(0, 3)).toEqual(['-o', 'User=bob', '-N']);
    expect(argv.slice(-3)).toEqual(['-t', 'termag-devbox', 'ls']);
    expect(argv).toContain('BatchMode=yes');
  });
});

describe('inDirectory', () => {
  it('changes into the quoted directory first', () => {
    expect(inDirectory('/home/a b/termag/projects/x', 'ls')).toBe("cd '/home/a b/termag/projects/x' && ls");
  });
});
