import { describe, expect, it, vi } from 'vitest';

vi.mock('./handoffCommand', () => ({
  isHandoffCommand: (text: string) => /^handoff(\s+(clear|compact|restart))?$/i.test(text.trim()),
}));

import { helpTopic, parseSlashCommand, slashHelp } from './slashCommand';

const send = (text: string, literal = false) => ({ kind: 'send', text, literal });

describe('parseSlashCommand', () => {
  it('claims a command word only in the forms it takes', () => {
    expect(parseSlashCommand('projects')).toEqual({ kind: 'projects' });
    expect(parseSlashCommand('projects ls')).toEqual(send('projects ls'));
    expect(parseSlashCommand('ls')).toEqual({ kind: 'sessions' });
    expect(parseSlashCommand('sessions')).toEqual({ kind: 'sessions' });
    expect(parseSlashCommand('ls -la')).toEqual(send('ls -la'));
    expect(parseSlashCommand('switch web/fix-login')).toEqual({ kind: 'switch', target: 'web/fix-login' });
    expect(parseSlashCommand('switch to main and pull')).toEqual(send('switch to main and pull'));
    expect(parseSlashCommand('attach alice-web-agent')).toEqual({ kind: 'attach', session: 'alice-web-agent' });
    expect(parseSlashCommand('attach the logs to the PR')).toEqual(send('attach the logs to the PR'));
    expect(parseSlashCommand('create web2')).toEqual({ kind: 'create', name: 'web2' });
    expect(parseSlashCommand('create a test for the parser')).toEqual(send('create a test for the parser'));
  });

  it('answers a command word without its argument with that command\'s help', () => {
    expect(parseSlashCommand('switch')).toEqual({ kind: 'help', topic: 'switch' });
    expect(parseSlashCommand('attach')).toEqual({ kind: 'help', topic: 'attach' });
    expect(parseSlashCommand('create')).toEqual({ kind: 'help', topic: 'create' });
    expect(parseSlashCommand('local detach')).toEqual({ kind: 'help', topic: 'local' });
  });

  it('needs a whole word: ctrl and local are not prefixes', () => {
    expect(parseSlashCommand('ctrl')).toEqual({ kind: 'ctrl', text: '' });
    expect(parseSlashCommand('ctrl  git status')).toEqual({ kind: 'ctrl', text: 'git status' });
    expect(parseSlashCommand('ctrlz')).toEqual(send('ctrlz'));
    expect(parseSlashCommand('localize the strings')).toEqual(send('localize the strings'));
    expect(parseSlashCommand('local tests fail, fix them')).toEqual(send('local tests fail, fix them'));
  });

  it('parses the local forms', () => {
    expect(parseSlashCommand('local')).toEqual({ kind: 'local', local: { action: 'list' } });
    expect(parseSlashCommand('local ls')).toEqual({ kind: 'local', local: { action: 'list' } });
    expect(parseSlashCommand('local list')).toEqual({ kind: 'local', local: { action: 'list' } });
    expect(parseSlashCommand('local laptop')).toEqual({ kind: 'local', local: { action: 'register', name: 'laptop' } });
    expect(parseSlashCommand('local detach laptop')).toEqual({ kind: 'local', local: { action: 'detach', name: 'laptop' } });
  });

  it('parses help and its topics, and leaves other text after help to the agent', () => {
    expect(parseSlashCommand('help')).toEqual({ kind: 'help', topic: null });
    expect(parseSlashCommand('help switch')).toEqual({ kind: 'help', topic: 'switch' });
    expect(parseSlashCommand('help sessions')).toEqual({ kind: 'help', topic: 'ls' });
    expect(parseSlashCommand('help routing')).toEqual({ kind: 'help', topic: 'routing' });
    expect(parseSlashCommand('help me')).toEqual(send('help me'));
    expect(parseSlashCommand('help me fix the login test')).toEqual(send('help me fix the login test'));
  });

  it('leaves the handoff forms to isHandoffCommand', () => {
    expect(parseSlashCommand('handoff compact')).toEqual({ kind: 'handoff' });
    expect(parseSlashCommand('handoff please write the docs')).toEqual(send('handoff please write the docs'));
  });

  it('types the rest as written after -- (or the em dash iOS makes of it)', () => {
    expect(parseSlashCommand('-- help')).toEqual(send('help', true));
    expect(parseSlashCommand('-- !ls')).toEqual(send('!ls', true));
    expect(parseSlashCommand('— projects')).toEqual(send('projects', true));
    expect(parseSlashCommand('--')).toEqual(send('', true));
    expect(parseSlashCommand('--help')).toEqual(send('--help'));
  });

  it('matches command words in any casing and keeps the casing of their arguments', () => {
    expect(parseSlashCommand('Projects')).toEqual({ kind: 'projects' });
    expect(parseSlashCommand('Switch Web/Fix')).toEqual({ kind: 'switch', target: 'Web/Fix' });
    expect(parseSlashCommand('Ctrl Git status')).toEqual({ kind: 'ctrl', text: 'Git status' });
    expect(parseSlashCommand('Local LS')).toEqual({ kind: 'local', local: { action: 'list' } });
    expect(parseSlashCommand('local Detach Laptop')).toEqual({ kind: 'local', local: { action: 'detach', name: 'Laptop' } });
    expect(parseSlashCommand('Local Laptop')).toEqual({ kind: 'local', local: { action: 'register', name: 'Laptop' } });
    expect(parseSlashCommand('Handoff')).toEqual({ kind: 'handoff' });
    expect(parseSlashCommand('Help Ctrl')).toEqual({ kind: 'help', topic: 'ctrl' });
    expect(parseSlashCommand('Run the tests')).toEqual(send('Run the tests'));
  });

  it('sends everything else, including empty text and !keys', () => {
    expect(parseSlashCommand('')).toEqual(send(''));
    expect(parseSlashCommand('  !2 ')).toEqual(send('!2'));
    expect(parseSlashCommand('run the tests')).toEqual(send('run the tests'));
  });
});

describe('slashHelp', () => {
  it('lists every command, the operators\' only for them', () => {
    const scoped = slashHelp(null, { unscoped: false });
    for (const word of ['ctrl', 'handoff', 'projects', 'switch', 'attach', 'ls', 'create', 'help']) {
      expect(scoped).toContain(`\`/t ${word}`);
    }
    expect(scoped).not.toContain('/t local');
    expect(slashHelp(null, { unscoped: true })).toContain('`/t local');
  });

  it('explains one command', () => {
    expect(slashHelp('switch', { unscoped: false })).toMatch(/^\*`\/t switch <project>\[\/<workstream>\]`\*/);
    expect(slashHelp('type', { unscoped: false })).toContain('`/t -- <text>`');
  });

  it('names a topic by command word or alias, in any casing', () => {
    expect(helpTopic('CTRL')).toBe('ctrl');
    expect(helpTopic('--')).toBe('type');
    expect(helpTopic('sessions')).toBe('ls');
    expect(helpTopic('constructor')).toBeNull();
    expect(helpTopic(undefined)).toBeNull();
  });
});
