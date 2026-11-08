import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlagUser } from './featureFlags';
import { prisma } from '../db';
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
  it.each<[boolean, boolean, BoxGateState]>([
    [false, false, 'off'],
    [false, true, 'off'],
    [true, true, 'clear'],
    [true, false, 'blocked'],
  ])('required=%s hasGithubCredential=%s → %s', (required, hasGithubCredential, state) => {
    const facts = { required, hasGithubCredential };
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
    vi.mocked(prisma.userCredential.findUnique).mockReset();
  });

  it('reports a stored github row', async () => {
    vi.mocked(prisma.userCredential.findUnique).mockResolvedValue({ provider: 'github' } as never);
    const facts = await readBoxCreationFacts(USER);
    expect(prisma.userCredential.findUnique).toHaveBeenCalledWith({
      where: { userId_provider: { userId: USER.id, provider: 'github' } },
      select: { provider: true },
    });
    expect(facts.hasGithubCredential).toBe(true);
  });

  it('reports no row', async () => {
    vi.mocked(prisma.userCredential.findUnique).mockResolvedValue(null);
    const facts = await readBoxCreationFacts(USER);
    expect(prisma.userCredential.findUnique).toHaveBeenCalledWith({
      where: { userId_provider: { userId: USER.id, provider: 'github' } },
      select: { provider: true },
    });
    expect(facts.hasGithubCredential).toBe(false);
  });
});
