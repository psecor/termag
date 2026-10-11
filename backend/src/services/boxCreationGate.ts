import { prisma } from '../db';
import { getCallerProofConfig } from './callerIdentity';
import { getCredentialStoreConfig } from './credentialStore';
import { getGithubBrokerUrl } from './githubBroker';
import { boolVariation } from './featureFlags';
import type { FlagUser } from './featureFlags';
import type { RouteResult } from '../routes/routeResult';

export interface BoxCreationFacts {
  required: boolean;
  flagOn: boolean;
  hasGithubCredential: boolean;
}

export type BoxGateState = 'off' | 'clear' | 'blocked';

function classify(facts: BoxCreationFacts): BoxGateState {
  if (!facts.required || !facts.flagOn) return 'off';
  if (facts.hasGithubCredential) return 'clear';
  return 'blocked';
}

export function githubRequiredForBoxes(env: NodeJS.ProcessEnv = process.env): boolean {
  return getCredentialStoreConfig(env) !== null
    && getGithubBrokerUrl(env) !== null
    && getCallerProofConfig(env) !== null;
}

export function boxCreationRefusal(
  facts: BoxCreationFacts,
): RouteResult<{ error: 'Connect GitHub in Settings before adding a box'; code: 'github-required' }> | null {
  if (classify(facts) !== 'blocked') return null;
  return {
    status: 409,
    body: { error: 'Connect GitHub in Settings before adding a box', code: 'github-required' },
  };
}

export function boxGateState(facts: BoxCreationFacts): BoxGateState {
  return classify(facts);
}

export async function hasGithubCredential(userId: string): Promise<boolean> {
  const row = await prisma.userCredential.findUnique({
    where: { userId_provider: { userId, provider: 'github' } },
    select: { provider: true },
  });
  return row !== null;
}

export async function readBoxCreationFacts(user: FlagUser): Promise<BoxCreationFacts> {
  const [flagOn, credential] = await Promise.all([
    boolVariation('repo-first-gate-enabled', user, false),
    hasGithubCredential(user.id),
  ]);
  return {
    required: githubRequiredForBoxes(),
    flagOn,
    hasGithubCredential: credential,
  };
}
