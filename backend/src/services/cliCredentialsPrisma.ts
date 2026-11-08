import { prisma } from '../db';
import { boxGateState, readBoxCreationFacts } from './boxCreationGate';
import { getClaudeGatewayConfig } from './claudeGateway';
import type { CliCredentials } from './cliCredentials';
import { CredentialStoreUnavailableError } from './cliCredentials';
import { deliverToUserBoxes } from './credentialDelivery';
import { deleteCredentials, getCredentialStoreConfig, githubStoreDeps, readGithubOrgAccess } from './credentialStore';
import { connectGithub, recheckGithub } from './githubCredential';
import { listSshKeys, removeSshKey } from './sshKeyRegistration';

/** The same reads and writes as the Settings page (routes/credentials.ts, routes/sshKeys.ts). */
export const prismaCliCredentials: CliCredentials = {
  async status(userId) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        claudeGatewayEnabled: true,
        credentials: { select: { provider: true, label: true, updatedAt: true } },
        // What the box gate's flag is evaluated on (an FlagUser).
        googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true,
      },
    });
    const github = user.credentials.find(c => c.provider === 'github') ?? null;
    const cfg = getCredentialStoreConfig();
    const orgs = github && cfg ? (await readGithubOrgAccess(userId)) ?? {} : {};
    return {
      github: {
        available: cfg !== null,
        connected: github ? { label: github.label, updatedAt: github.updatedAt, orgs } : null,
        boxGate: boxGateState(await readBoxCreationFacts({ id: userId, ...user })),
      },
      claudeGateway: { available: getClaudeGatewayConfig() !== null, enabled: user.claudeGatewayEnabled },
    };
  },

  listSshKeys,
  removeSshKey,

  async connectGithub(userId, token) {
    const cfg = getCredentialStoreConfig();
    if (!cfg) throw new CredentialStoreUnavailableError();
    const connected = await connectGithub(token, githubStoreDeps(cfg, userId));
    void deliverToUserBoxes(userId);
    return { label: connected.label };
  },

  async recheckGithub(userId) {
    const cfg = getCredentialStoreConfig();
    if (!cfg) throw new CredentialStoreUnavailableError();
    await recheckGithub(githubStoreDeps(cfg, userId));
  },

  // A row delete: no KMS call, so it works with the store unconfigured.
  async disconnectGithub(userId) {
    await deleteCredentials(userId, ['github']);
    void deliverToUserBoxes(userId);
  },

  async setClaudeGateway(userId, enabled) {
    await prisma.user.update({ where: { id: userId }, data: { claudeGatewayEnabled: enabled } });
    void deliverToUserBoxes(userId);
  },
};
