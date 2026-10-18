/**
 * The bucket, presigner role and KMS key spaces use, derived from the
 * orchestrator's own AWS identity. Nothing is configured: the `spaces-enabled`
 * flag is the only switch, so turning spaces on or off never needs the host
 * roll an env change would.
 *
 * The names are the ones example-org/terraform creates in
 * projects/termag/root-modules/orchestrator/spaces.tf:
 *
 *   bucket   termag-spaces-<account>-<region>-an   (the s3-bucket module's
 *            account-regional namespace for bucket_name "termag-spaces")
 *   role     arn:aws:iam::<account>:role/termag-spaces-presigner
 *   key      arn:aws:kms:<region>:<account>:alias/termag-spaces
 *
 * The key is named by its alias ARN, not resolved to the key ARN: it is only
 * ever sent as the SSE-KMS key id, S3 resolves the alias itself, and the
 * bucket policy's DenyOtherEncryptionKey accepts either the key ARN or exactly
 * this alias ARN. A bare `alias/termag-spaces` would be refused by that
 * policy, which compares the header as a string.
 *
 * The account comes from STS GetCallerIdentity with the host's ambient
 * credentials (the orchestrator role), the region from the SDK's region chain
 * (AWS_REGION, which box provisioning already needs). On the e2e stack both
 * come from Floci through the standard AWS_ENDPOINT_URL, so no override exists.
 */
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

export const SPACES_RESOURCE_NAME = 'termag-spaces';
export const SPACES_PRESIGNER_ROLE_NAME = 'termag-spaces-presigner';

export interface SpaceResources {
  accountId: string;
  region: string;
  bucket: string;
  roleArn: string;
  kmsKeyId: string;
}

export class SpacesUnavailableError extends Error {
  readonly code = 'spaces_unavailable';
}

const ACCOUNT_RE = /^\d{12}$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;

export function spaceResourceNames(accountId: string, region: string): SpaceResources {
  if (!ACCOUNT_RE.test(accountId)) throw new SpacesUnavailableError(`Unexpected AWS account id ${JSON.stringify(accountId)}`);
  if (!REGION_RE.test(region)) throw new SpacesUnavailableError(`Unexpected AWS region ${JSON.stringify(region)}`);
  return {
    accountId,
    region,
    bucket: `${SPACES_RESOURCE_NAME}-${accountId}-${region}-an`,
    roleArn: `arn:aws:iam::${accountId}:role/${SPACES_PRESIGNER_ROLE_NAME}`,
    kmsKeyId: `arn:aws:kms:${region}:${accountId}:alias/${SPACES_RESOURCE_NAME}`,
  };
}

export interface IdentitySource {
  /** The SDK's resolved region, or undefined when there is none. */
  region(): Promise<string | undefined>;
  accountId(): Promise<string | undefined>;
}

export function stsIdentitySource(): IdentitySource {
  const sts = new STSClient({});
  return {
    async region() {
      try { return await sts.config.region(); } catch { return undefined; }
    },
    async accountId() {
      return (await sts.send(new GetCallerIdentityCommand({}))).Account;
    },
  };
}

/** Resolve once and keep it; after a failure, try again no sooner than retryMs. */
export function spaceResourcesResolver(
  source: IdentitySource = stsIdentitySource(),
  opts: { retryMs?: number; now?: () => number } = {},
): () => Promise<SpaceResources> {
  const retryMs = opts.retryMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let resolved: SpaceResources | null = null;
  let inFlight: Promise<SpaceResources> | null = null;
  let failure: { at: number; error: SpacesUnavailableError } | null = null;

  async function resolve(): Promise<SpaceResources> {
    const region = await source.region();
    if (!region) throw new SpacesUnavailableError('No AWS region (set AWS_REGION)');
    let accountId: string | undefined;
    try {
      accountId = await source.accountId();
    } catch (err) {
      throw new SpacesUnavailableError(`Could not read the AWS account id: ${(err as Error).message}`);
    }
    if (!accountId) throw new SpacesUnavailableError('GetCallerIdentity returned no account');
    return spaceResourceNames(accountId, region);
  }

  return async () => {
    if (resolved) return resolved;
    if (failure && now() - failure.at < retryMs) throw failure.error;
    inFlight ??= resolve().then(
      r => {
        resolved = r;
        console.log(`[SPACES] bucket ${r.bucket}, presigner ${r.roleArn}, key ${r.kmsKeyId}`);
        return r;
      },
      err => {
        const error = err instanceof SpacesUnavailableError ? err : new SpacesUnavailableError((err as Error).message);
        failure = { at: now(), error };
        console.warn(`[SPACES] unavailable: ${error.message}`);
        throw error;
      },
    ).finally(() => { inFlight = null; });
    return inFlight;
  };
}
