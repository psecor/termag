import { describe, it, expect } from 'vitest';
import { classifyAuthor, classifyPr, bodyWindow, DEFAULT_AGENT_LOGINS, DEFAULT_BOT_LOGINS } from './classify';

const lists = { agentLogins: DEFAULT_AGENT_LOGINS, botLogins: DEFAULT_BOT_LOGINS };
const pr = (over: Partial<Parameters<typeof classifyPr>[0]>) => ({ authorLogin: 'ada-dev', authorType: 'User', body: '', commits: [], ...over });

describe('classifyAuthor', () => {
  it('separates people, agents and automation', () => {
    expect(classifyAuthor('ada-dev', 'User', lists)).toBe('human');
    expect(classifyAuthor('devin-ai-integration[bot]', 'Bot', lists)).toBe('agent');
    expect(classifyAuthor('Claude[bot]', 'Bot', lists)).toBe('agent');
    expect(classifyAuthor('dependabot[bot]', 'Bot', lists)).toBe('automation');
    expect(classifyAuthor('some-config-bot', 'Bot', lists)).toBe('automation');
  });
  it('matches GraphQL bot logins, which drop the [bot] suffix', () => {
    expect(classifyAuthor('devin-ai-integration', 'Bot', lists)).toBe('agent');
    expect(classifyAuthor('claude', 'Bot', lists)).toBe('agent');
    expect(classifyAuthor('cursor', 'Bot', lists)).toBe('agent');
    expect(classifyAuthor('dependabot', 'Bot', lists)).toBe('automation');
  });
  it('never takes a person named like an agent for the agent', () => {
    expect(classifyAuthor('claude', 'User', lists)).toBe('human');
    expect(classifyAuthor('cursor', 'User', lists)).toBe('human');
  });
  it('treats a listed User-typed account as a bot, and a missing author as automation', () => {
    expect(classifyAuthor('ExampleReleaseBot', 'User', { ...lists, botLogins: ['examplereleasebot'] })).toBe('automation');
    expect(classifyAuthor('', '', lists)).toBe('automation');
  });
});

describe('classifyPr credit', () => {
  it('credits a human PR to its author and marks agent co-authorship', () => {
    expect(classifyPr(pr({ authorLogin: 'Ada-Dev' }), lists)).toEqual({ authorClass: 'human', creditedLogin: 'ada-dev', creditSource: 'author', agentAssisted: false });
    const assisted = classifyPr(pr({ commits: [{ messageBody: 'fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>', authorLogins: ['ada-dev'] }] }), lists);
    expect(assisted).toMatchObject({ authorClass: 'human', creditedLogin: 'ada-dev', agentAssisted: true });
  });

  it('credits an agent PR to the human commit author first', () => {
    // Cursor: the agent commits as cursoragent, the person pushes too.
    const c = classifyPr(pr({ authorLogin: 'cursor', authorType: 'Bot', commits: [
      { messageBody: '', authorLogins: ['cursoragent'] },
      { messageBody: 'Co-authored-by: Bea <bea@example.com>', authorLogins: ['cursoragent', 'bea-eng'] },
    ] }), lists);
    expect(c).toEqual({ authorClass: 'agent', creditedLogin: 'bea-eng', creditSource: 'commit-author', agentAssisted: true });
  });

  it('falls back to a noreply co-author trailer, skipping the agent\'s own', () => {
    const c = classifyPr(pr({ authorLogin: 'claude[bot]', authorType: 'Bot', commits: [{
      messageBody: 'Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>\nCo-Authored-By: Cy Dev <1234+cy-dev@users.noreply.github.com>',
      authorLogins: ['claude'],
    }] }), lists);
    expect(c).toMatchObject({ creditedLogin: 'cy-dev', creditSource: 'co-author' });
  });

  it('ignores a work-email co-author it cannot map, then reads Requested by in the body tail', () => {
    const body = bodyWindow(`${'x'.repeat(5000)}\n\nRequested by: Dee Engineer (@dee-eng)\nLink to Devin run: …`);
    const c = classifyPr(pr({ authorLogin: 'devin-ai-integration[bot]', authorType: 'Bot', body, commits: [{
      messageBody: 'Co-Authored-By: Devin AI <158243242+devin-ai-integration[bot]@users.noreply.github.com>\nCo-authored-by: Dee <dee@example.com>',
      authorLogins: ['devin-ai-integration[bot]'],
    }] }), lists);
    expect(c).toMatchObject({ creditedLogin: 'dee-eng', creditSource: 'body' });
  });

  it('leaves an agent PR with no human signal uncredited', () => {
    const c = classifyPr(pr({ authorLogin: 'devin-ai-integration[bot]', authorType: 'Bot', commits: [{ messageBody: '', authorLogins: ['devin-ai-integration[bot]'] }] }), lists);
    expect(c).toEqual({ authorClass: 'agent', creditedLogin: null, creditSource: 'none', agentAssisted: true });
  });

  it('never credits automation', () => {
    expect(classifyPr(pr({ authorLogin: 'dependabot[bot]', authorType: 'Bot', commits: [{ messageBody: '', authorLogins: ['ada-dev'] }] }), lists))
      .toMatchObject({ authorClass: 'automation', creditedLogin: null, creditSource: 'none' });
  });
});

describe('bodyWindow', () => {
  it('keeps short bodies whole and the head and tail of long ones', () => {
    expect(bodyWindow('short')).toBe('short');
    const w = bodyWindow('h'.repeat(2000) + 'm'.repeat(5000) + 't'.repeat(3000));
    expect(w.startsWith('h'.repeat(1024))).toBe(true);
    expect(w.endsWith('t'.repeat(2048))).toBe(true);
    expect(w).not.toContain('m');
    expect(bodyWindow(null)).toBe('');
  });
});
