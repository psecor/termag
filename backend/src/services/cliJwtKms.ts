import { createPublicKey } from 'crypto';
import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { CliJwt, localCliJwtKey, type CliJwtKey } from './cliJwt';

const SIGNING_ALGORITHM = 'RSASSA_PKCS1_V1_5_SHA_256';

/** An asymmetric KMS key (RSA_2048, SIGN_VERIFY): the private half never leaves KMS. */
export async function kmsCliJwtKey(client: KMSClient, keyId: string): Promise<CliJwtKey> {
  const out = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (out.KeyUsage !== 'SIGN_VERIFY' || !out.SigningAlgorithms?.includes(SIGNING_ALGORITHM) || !out.PublicKey) {
    throw new Error(`${keyId} is not an RSA signing key that supports ${SIGNING_ALGORITHM}`);
  }
  return {
    publicKey: createPublicKey({ key: Buffer.from(out.PublicKey), format: 'der', type: 'spki' }),
    async sign(data) {
      const res = await client.send(new SignCommand({
        KeyId: keyId, Message: data, MessageType: 'RAW', SigningAlgorithm: SIGNING_ALGORITHM,
      }));
      if (!res.Signature) throw new Error(`KMS returned no signature for ${keyId}`);
      return Buffer.from(res.Signature);
    },
  };
}

function cliJwtKeyIds(env: NodeJS.ProcessEnv): string[] {
  return (env.CLI_JWT_KMS_KEY_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
}

/**
 * CLI_JWT_KMS_KEY_IDS lists KMS key ids (ARNs or alias/ names), signing key
 * first. CLI_JWT_ISSUER must equal the ALB rule's issuer; it defaults to the
 * orchestrator's public URL.
 */
export async function cliJwtFromEnv(env: NodeJS.ProcessEnv, defaultIssuer: string): Promise<CliJwt> {
  const issuer = env.CLI_JWT_ISSUER?.trim() || defaultIssuer;
  const keyIds = cliJwtKeyIds(env);
  if (keyIds.length === 0) {
    console.warn('[CLI] CLI_JWT_KMS_KEY_IDS is unset: CLI access tokens are signed with an in-memory key and stop verifying on restart');
    return new CliJwt(issuer, [localCliJwtKey()]);
  }
  const client = new KMSClient({});
  return new CliJwt(issuer, await Promise.all(keyIds.map(id => kmsCliJwtKey(client, id))));
}
