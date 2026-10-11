import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlagUser } from './featureFlags';
import { prisma } from '../db';
import { boolVariation } from './featureFlags';
import {
  boxCreationRefusal,
  boxGateState,
  githubRequiredForBoxes,
  readBoxCreationFacts,
  type BoxGateState,
} from './boxCreationGate';

vi.mock('../db', () => ({
  prisma: { userCredential: { findUnique: vi.fn() } },
}));

vi.mock('./featureFlags', () => ({
  boolVariation: vi.fn(),
}));

const REFUSAL = {
  status: 409,
  body: { error: 'Connect GitHub in Settings before adding a box', code: 'github-required' },
};

const KEY = 'arn:aws:kms:us-east-1:111122223333:key/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
const BROKER = 'https://github.example.com';
const CALLER = 'arn:aws:iam::111122223333:role/gateway';

function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CREDENTIAL_STORE_KMS_KEY_ID: KEY,
    GITHUB_BROKER_URL: BROKER,
    GATEWAY_AUTHZ_ALLOWED_CALLER_ARNS: CALLER,
    AWS_REGION: 'us-east-1',
    ...over,
  };
}

function without(key: string): NodeJS.ProcessEnv {
  const next = env();
  delete next[key];
  return next;
}

const USER: FlagUser = {
  id: 'user-1',
  googleEmail: 'a@example.com',
  displayName: 'A',
  unixUsername: 'a',
  defaultAgentProvider: 'claude',
};

describe('boxGateState and boxCreationRefusal', () => {
  it.each<[boolean, boolean, boolean, BoxGateState]>([
    [false, false, false, 'off'],
    [false, false, true, 'off'],
    [false, true, false, 'off'],
    [false, true, true, 'off'],
    [true, false, false, 'off'],
    [true, false, true, 'off'],
    [true, true, true, 'clear'],
    [true, true, false, 'blocked'],
  ])('required=%s flagOn=%s hasGithubCredential=%s → %s', (required, flagOn, hasGithubCredential, state) => {
    const facts = { required, flagOn, hasGithubCredential };
    expect(boxGateState(facts)).toBe(state);
    if (state === 'blocked') expect(boxCreationRefusal(facts)).toEqual(REFUSAL);
    else expect(boxCreationRefusal(facts)).toBeNull();
  });
});

describe('githubRequiredForBoxes', () => {
  it('is true only when the credential store, broker, and caller proof all parse', () => {
    expect(githubRequiredForBoxes(env())).toBe(true);
  });

  it('is false when any of the three settings is missing', () => {
    expect(githubRequiredForBoxes(without('CREDENTIAL_STORE_KMS_KEY_ID'))).toBe(false);
    expect(githubRequiredForBoxes(without('GITHUB_BROKER_URL'))).toBe(false);
    expect(githubRequiredForBoxes(without('GATEWAY_AUTHZ_ALLOWED_CALLER_ARNS'))).toBe(false);
  });

  it('is false when a parser rejects the value', () => {
    expect(githubRequiredForBoxes(env({ CREDENTIAL_STORE_KMS_KEY_ID: 'alias/termag-user-credentials' }))).toBe(false);
    expect(githubRequiredForBoxes(env({ GITHUB_BROKER_URL: 'http://github.example.com' }))).toBe(false);
    expect(githubRequiredForBoxes(env({ GITHUB_BROKER_URL: 'https://github.example.com:8443' }))).toBe(false);
    expect(githubRequiredForBoxes(without('AWS_REGION'))).toBe(false);
  });
});

describe('readBoxCreationFacts', () => {
  beforeEach(() => {
    vi.mocked(boolVariation).mockReset();
    vi.mocked(prisma.userCredential.findUnique).mockReset();
  });

  it('reports a stored github row and reads the flag with fallback false', async () => {
    vi.mocked(boolVariation).mockResolvedValue(true);
    vi.mocked(prisma.userCredential.findUnique).mockResolvedValue({ provider: 'github' } as never);
    const facts = await readBoxCreationFacts(USER);
    expect(boolVariation).toHaveBeenCalledWith('repo-first-gate-enabled', USER, false);
    expect(prisma.userCredential.findUnique).toHaveBeenCalledWith({
      where: { userId_provider: { userId: USER.id, provider: 'github' } },
      select: { provider: true },
    });
    expect(facts.flagOn).toBe(true);
    expect(facts.hasGithubCredential).toBe(true);
  });

  it('reports no row, and still looks the row up when the flag is off', async () => {
    vi.mocked(boolVariation).mockResolvedValue(false);
    vi.mocked(prisma.userCredential.findUnique).mockResolvedValue(null);
    const facts = await readBoxCreationFacts(USER);
    expect(boolVariation).toHaveBeenCalledWith('repo-first-gate-enabled', USER, false);
    expect(prisma.userCredential.findUnique).toHaveBeenCalledWith({
      where: { userId_provider: { userId: USER.id, provider: 'github' } },
      select: { provider: true },
    });
    expect(facts.flagOn).toBe(false);
    expect(facts.hasGithubCredential).toBe(false);
  });
});
