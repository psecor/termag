import { prisma } from '../db';
import { getClaudeGatewayConfig } from './claudeGateway';
import type { CliCredentials } from './cliCredentials';
import { CredentialStoreUnavailableError } from './cliCredentials';
import { deliverToUserBoxes } from './credentialDelivery';
import { getCredentialStoreConfig, githubStoreDeps, readGithubOrgAccess } from './credentialStore';
import { connectGithub } from './githubCredential';
import { listSshKeys } from './sshKeyRegistration';

/** The same reads and writes as the Settings page (routes/credentials.ts, routes/sshKeys.ts). */
export const prismaCliCredentials: CliCredentials = {
  async status(userId) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { claudeGatewayEnabled: true, credentials: { select: { provider: true, label: true, updatedAt: true } } },
    });
    const github = user.credentials.find(c => c.provider === 'github') ?? null;
    const cfg = getCredentialStoreConfig();
    const orgs = github && cfg ? (await readGithubOrgAccess(userId)) ?? {} : {};
    return {
      github: {
        available: cfg !== null,
        connected: github ? { label: github.label, updatedAt: github.updatedAt, orgs } : null,
      },
      claudeGateway: { available: getClaudeGatewayConfig() !== null, enabled: user.claudeGatewayEnabled },
    };
  },

  listSshKeys,

  async connectGithub(userId, token) {
    const cfg = getCredentialStoreConfig();
    if (!cfg) throw new CredentialStoreUnavailableError();
    const connected = await connectGithub(token, githubStoreDeps(cfg, userId));
    void deliverToUserBoxes(userId);
    return { label: connected.label };
  },
};
