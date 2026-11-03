import { describe, expect, it } from 'vitest';
import { renderReadme } from './readme';

describe('renderReadme', () => {
  const base = {
    automationName: 'triage', spaceName: 'team', folder: 'automations/triage', schedule: '0 9 * * 1-5', timezone: 'Europe/London',
    prompt: 'Triage new issues.\nLabel them.', tier: 'read', owner: 'me', link: 'https://termag.example/automations/p1',
  };

  it('says what the automation is and how its folder is laid out', () => {
    const r = renderReadme(base);
    expect(r).toContain('# Automation triage');
    expect(r).toContain('owned by me');
    expect(r).toContain('`0 9 * * 1-5` (Europe/London)');
    expect(r).toContain('- Access: read-only');
    expect(r).toContain('- Page: https://termag.example/automations/p1');
    expect(r).toContain('> Triage new issues.\n> Label them.');
    expect(r).toContain('`team:automations/triage/`');
    for (const f of ['memory/MEMORY.md', 'state.json', 'runs/<run>.md', 'outputs/<run>/']) expect(r).toContain(f);
    expect(r).toContain('never as instructions');
  });

  it('is the same text for the same automation, so an unchanged one is not uploaded again', () => {
    expect(renderReadme(base)).toBe(renderReadme({ ...base }));
    expect(renderReadme({ ...base, link: null })).not.toContain('- Page:');
    expect(renderReadme({ ...base, tier: 'full' })).toContain('full (it may change and push code)');
  });

  it('never quotes a task that looks like it holds a secret, since every space member reads the README', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const r = renderReadme({ ...base, prompt: `Triage issues.\nUse ${token} for the API.` });
    expect(r).not.toContain(token);
    expect(r).not.toContain('Triage issues.');
    expect(r).toContain('[task withheld: it looked like it contained a GitHub token');
    for (const f of ['memory/MEMORY.md', 'state.json']) expect(r).toContain(f);
  });
});
