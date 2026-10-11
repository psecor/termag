/**
 * What `termag doctor` reads and fixes on the orchestrator: the owner's SSH
 * keys (read only), the GitHub token (the credential store) and whether boxes
 * get Claude through the gateway. An interface so routes/cliCredentials.ts can
 * be tested against a fake; the Prisma implementation is
 * cliCredentialsPrisma.ts. No method returns a credential value.
 */
import type { OrgAccess } from './githubRepos';
import type { SshKeyInfo } from './sshKeyRegistration';

export interface CliCredentialStatus {
  github: {
    available: boolean;
    connected: { label: string; updatedAt: Date; orgs: Record<string, OrgAccess> } | null;
  };
  claudeGateway: { available: boolean; enabled: boolean };
}

/** The orchestrator has no credential store (CREDENTIAL_STORE_KMS_KEY_ID unset). */
export class CredentialStoreUnavailableError extends Error {
  constructor() {
    super('The credential store is not configured on this orchestrator.');
  }
}

export interface CliCredentials {
  status(userId: string): Promise<CliCredentialStatus>;
  listSshKeys(userId: string): Promise<SshKeyInfo[]>;
  /** Throws CredentialInputError (bad token) or CredentialStoreUnavailableError. */
  connectGithub(userId: string, token: unknown): Promise<{ label: string }>;
}
