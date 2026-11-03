/**
 * The AWS Encryption SDK construction the orchestrator seals stored secrets
 * with: user_credentials (credentialStore.ts)
 * and chat transcripts (chatTranscriptStore.ts). Each sealed value is one
 * message under a fresh AES-256-GCM data key with key commitment, that data
 * key encrypted by a KMS key named by ARN, and an encryption context that KMS
 * binds the data key to and the SDK binds the ciphertext to. Opening also
 * checks the context against what the caller expects, so a value copied onto
 * another row never opens as that row's.
 */

import {
  AlgorithmSuiteIdentifier,
  buildClient,
  CommitmentPolicy,
  getLocalCryptographicMaterialsCache,
  KmsKeyringNode,
  NodeCachingMaterialsManager,
  type KeyringNode,
  type NodeMaterialsManager,
} from '@aws-crypto/client-node';

export const KMS_KEY_ARN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/;

// Without signing: the one role that decrypts is also the one that encrypts,
// so a signature would prove nothing a GCM tag doesn't.
const SUITE = AlgorithmSuiteIdentifier.ALG_AES256_GCM_IV12_TAG16_HKDF_SHA512_COMMIT_KEY;

const { encrypt, decrypt } = buildClient({
  commitmentPolicy: CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT,
  maxEncryptedDataKeys: 1,
});

const kmsKeyrings = new Map<string, KeyringNode>();

/** A strict KMS keyring for the key's ARN, one per ARN. */
export function kmsKeyring(kmsKeyArn: string): KeyringNode {
  let keyring = kmsKeyrings.get(kmsKeyArn);
  if (!keyring) {
    keyring = new KmsKeyringNode({ generatorKeyId: kmsKeyArn });
    kmsKeyrings.set(kmsKeyArn, keyring);
  }
  return keyring;
}

export interface DataKeyCache {
  /** How long a data key is reused, in ms. */
  maxAgeMs: number;
  /** How many messages one data key may seal. */
  maxMessages: number;
  /** How many data keys are kept. */
  capacity: number;
  partition: string;
}

/**
 * A materials manager that reuses data keys: messages sealed with the same
 * context within `maxAgeMs` share one GenerateDataKey, and a message whose
 * data key was opened within `maxAgeMs` opens without a KMS Decrypt.
 */
export function cachingMaterials(keyring: KeyringNode, cache: DataKeyCache): NodeMaterialsManager {
  return new NodeCachingMaterialsManager({
    backingMaterials: keyring,
    cache: getLocalCryptographicMaterialsCache(cache.capacity),
    partition: cache.partition,
    maxAge: cache.maxAgeMs,
    maxMessagesEncrypted: cache.maxMessages,
  });
}

export async function sealBytes(
  materials: KeyringNode | NodeMaterialsManager, plaintext: Buffer, encryptionContext: Record<string, string>,
): Promise<Buffer> {
  const { result } = await encrypt(materials, plaintext, { encryptionContext, suiteId: SUITE, plaintextLength: plaintext.length });
  return result;
}

/** The plaintext, or a throw of `mismatch` when the message was sealed under any other context. */
export async function openBytes(
  materials: KeyringNode | NodeMaterialsManager, ciphertext: Uint8Array, expected: Record<string, string>, mismatch: string,
): Promise<Buffer> {
  const { plaintext, messageHeader } = await decrypt(materials, Buffer.from(ciphertext));
  const actual = messageHeader.encryptionContext;
  const keys = Object.keys(actual);
  if (keys.length !== Object.keys(expected).length || keys.some(k => actual[k] !== expected[k])) {
    throw new Error(mismatch);
  }
  return plaintext;
}
