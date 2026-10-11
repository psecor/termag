/**
 * Pull-only ECR for box roles: the `termag-box-ecr-pull` inline policy that
 * lets `docker pull` on a box authenticate with the instance role
 * (docker-credential-ecr-login) instead of the owner's AWS SSO session.
 *
 * The repositories come from the box-provisioning terraform module's
 * `backend_env`, which also writes the same list into the box permissions
 * boundary. The boundary is the ceiling and this policy the grant, so the two
 * must name the same repositories: a repository missing from the boundary is
 * capped out whatever this policy says.
 *
 *   BOX_ECR_PULL_REPOSITORY_ARNS  comma-separated repository ARNs (wildcards
 *                                 allowed), pull-through-cache prefixes
 *                                 included; unset = off
 *
 * One statement covers the whole list, the same shape as the AMI builder's
 * read: ecr:BatchImportUpstreamImage only takes effect under a pull-through
 * cache prefix, so on a CI-pushed repository it grants nothing.
 */

export const BOX_ECR_PULL_INLINE_POLICY = 'termag-box-ecr-pull';

export interface BoxEcrPullConfig {
  repositoryArns: string[];
}

const REPOSITORY_ARN = /^arn:aws[a-z-]*:ecr:[a-z0-9-]+:\d{12}:repository\/\S+$/;

/**
 * Reads the ECR pull settings. Undefined when unset, and also when the list is
 * malformed: a bad entry turns the grant off rather than writing a policy IAM
 * would reject at every box launch.
 */
export function parseBoxEcrPull(env: NodeJS.ProcessEnv): BoxEcrPullConfig | undefined {
  const repositoryArns = [...new Set((env.BOX_ECR_PULL_REPOSITORY_ARNS ?? '').split(',').map(s => s.trim()).filter(Boolean))];
  if (repositoryArns.length === 0) return undefined;
  const malformed = repositoryArns.filter(arn => !REPOSITORY_ARN.test(arn));
  if (malformed.length > 0) {
    console.error(`[BOX] BOX_ECR_PULL_REPOSITORY_ARNS has entries that are not ECR repository ARNs (${malformed.join(', ')}); box ECR pull stays off`);
    return undefined;
  }
  return { repositoryArns };
}

export function boxEcrPullPolicyDocument(cfg: BoxEcrPullConfig): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Sid: 'BoxEcrAuth', Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
      {
        Sid: 'BoxEcrPull',
        Effect: 'Allow',
        Action: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchGetImage',
          'ecr:BatchImportUpstreamImage',
          'ecr:GetDownloadUrlForLayer',
        ],
        Resource: cfg.repositoryArns,
      },
    ],
  });
}

/**
 * Whether a role's current inline policy (GetRolePolicy returns it
 * URL-encoded; undefined when the role has none) differs from `desired`.
 * Compared as parsed JSON, so IAM's own re-serialization is not a difference.
 */
export function ecrPullPolicyNeedsUpdate(currentUrlEncoded: string | undefined, desired: string): boolean {
  if (currentUrlEncoded === undefined) return true;
  try {
    return canonical(JSON.parse(decodeURIComponent(currentUrlEncoded))) !== canonical(JSON.parse(desired));
  } catch {
    return true;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
