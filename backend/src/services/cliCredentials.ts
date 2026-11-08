/**
 * What `termag doctor` and the desktop's Settings read and change on the
 * orchestrator: the owner's SSH keys (read only), the GitHub token
 * (#139's credential store) and whether boxes get Claude through the gateway.
 * An interface so routes/cliCredentials.ts can be tested against a fake; the
 * Prisma implementation is cliCredentialsPrisma.ts. No method returns a
 * credential value.
 */
import type { BoxGateState } from './boxCreationGate';
import type { OrgAccess } from './githubRepos';
import type { RemoveSshKeyResult, SshKeyInfo } from './sshKeyRegistration';

export interface CliCredentialStatus {
  github: {
    available: boolean;
    connected: { label: string; updatedAt: Date; orgs: Record<string, OrgAccess> } | null;
    /** Whether adding a box needs a stored token (Settings: "A stored token is required to add boxes."). */
    boxGate: BoxGateState;
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
  removeSshKey(userId: string, id: string): Promise<RemoveSshKeyResult>;
  /** Throws CredentialInputError (bad token) or CredentialStoreUnavailableError. */
  connectGithub(userId: string, token: unknown): Promise<{ label: string }>;
  /** Re-reads the stored token's org access. Throws CredentialInputError (none stored, or GitHub refused it) or CredentialStoreUnavailableError. */
  recheckGithub(userId: string): Promise<void>;
  /** Deletes the stored token; needs no credential store. */
  disconnectGithub(userId: string): Promise<void>;
  setClaudeGateway(userId: string, enabled: boolean): Promise<void>;
}
