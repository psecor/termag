import { describe, expect, it } from 'vitest';
import { askOffersEnvironmentSteps } from './askService';

// Security Agent on #998 (04f6181a): an ask is pointed at `termag-env up` only where nothing caps it. A project
// made from a shared environment has its asks capped (no checkout shell as the box user), so its prompt never
// names the CLI that would run the checkout's steps outside the classifier.
describe('askOffersEnvironmentSteps', () => {
  const trusted = { chatTrustedAt: new Date(), kind: 'normal', environmentId: null };
  it('offers termag-env up on a trusted project of the owner\'s own', () => {
    expect(askOffersEnvironmentSteps(trusted)).toBe(true);
  });
  it('never on an untrusted project, an automation, or a project made from a shared environment', () => {
    expect(askOffersEnvironmentSteps({ ...trusted, chatTrustedAt: null })).toBe(false);
    expect(askOffersEnvironmentSteps({ ...trusted, kind: 'automation' })).toBe(false);
    expect(askOffersEnvironmentSteps({ ...trusted, environmentId: 'env-1' })).toBe(false);
  });
});

// Security Agent on #998 (2bf6e84c): an ask of a project from a shared environment gets Claude's auto mode (Bash,
// classifier-judged) only once its owner has trusted it, like the main chat and automations; until then dontAsk.
describe('askModeFor and the trust tick', () => {
  it('caps an untrusted shared-environment project to dontAsk, and a trusted one to auto', async () => {
    const { askModeFor } = await import('./askService');
    const caps = ['chat-auto-v1'];
    expect(askModeFor({ environmentId: 'e1', chatTrustedAt: null }, caps)).toBe('dontAsk');
    expect(askModeFor({ environmentId: 'e1', chatTrustedAt: new Date() }, caps)).toBe('auto');
    expect(askModeFor({ environmentId: null, chatTrustedAt: null }, caps)).toBeNull();
  });
});
