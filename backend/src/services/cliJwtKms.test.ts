import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';
import { GetPublicKeyCommand, SignCommand, type KMSClient } from '@aws-sdk/client-kms';
import { CliJwt } from './cliJwt';
import { cliJwtFromEnv, kmsCliJwtKey } from './cliJwtKms';

const KEY_ARN = 'arn:aws:kms:us-east-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';

function fakeKms(keyUsage = 'SIGN_VERIFY') {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signs: Array<Record<string, unknown>> = [];
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof GetPublicKeyCommand) {
      return {
        KeyUsage: keyUsage,
        SigningAlgorithms: ['RSASSA_PKCS1_V1_5_SHA_256', 'RSASSA_PSS_SHA_256'],
        PublicKey: new Uint8Array(publicKey.export({ format: 'der', type: 'spki' })),
      };
    }
    if (command instanceof SignCommand) {
      signs.push({ ...command.input, Message: undefined });
      return { Signature: new Uint8Array(sign('sha256', Buffer.from(command.input.Message!), privateKey)) };
    }
    throw new Error('unexpected command');
  });
  return { client: { send } as unknown as KMSClient, signs };
}

describe('kmsCliJwtKey', () => {
  it('signs RS256 in KMS over the raw signing input', async () => {
    const kms = fakeKms();
    const jwt = new CliJwt('https://termag.example.com/termag', [await kmsCliJwtKey(kms.client, KEY_ARN)]);
    const { token } = await jwt.issue('alice', 's1', Date.now());
    expect(jwt.verify(token, Date.now())).toMatchObject({ sub: 'alice', jti: 's1' });
    expect(kms.signs).toEqual([{ KeyId: KEY_ARN, MessageType: 'RAW', SigningAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256', Message: undefined }]);
  });

  it('refuses a key that cannot sign', async () => {
    await expect(kmsCliJwtKey(fakeKms('ENCRYPT_DECRYPT').client, KEY_ARN)).rejects.toThrow(/not an RSA signing key/);
  });
});

describe('cliJwtFromEnv', () => {
  it('falls back to an in-memory key, and takes the issuer from CLI_JWT_ISSUER', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const jwt = await cliJwtFromEnv({ CLI_JWT_ISSUER: ' https://app.example.com/termag ' }, 'http://localhost:5173');
    expect(jwt.issuer).toBe('https://app.example.com/termag');
    expect(jwt.jwks().keys).toHaveLength(1);
    expect((await cliJwtFromEnv({}, 'http://localhost:5173/termag')).issuer).toBe('http://localhost:5173/termag');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CLI_JWT_KMS_KEY_IDS is unset'));
    warn.mockRestore();
  });
});
