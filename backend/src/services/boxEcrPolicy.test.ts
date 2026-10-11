import { describe, it, expect, vi } from 'vitest';
import { boxEcrPullPolicyDocument, ecrPullPolicyNeedsUpdate, parseBoxEcrPull } from './boxEcrPolicy';
import { getBoxConfig } from './boxProvisioner';

const REPO = 'arn:aws:ecr:us-east-1:123456789012:repository';
const PUSHED = [`${REPO}/example-org/dev/*`, `${REPO}/example-org/event-warehouse-api`];
const CACHE = [`${REPO}/docker.io/*`, `${REPO}/ghcr.io/*`];
const ENV = { BOX_ECR_PULL_REPOSITORY_ARNS: [...PUSHED, ...CACHE].join(',') };

describe('parseBoxEcrPull', () => {
  it('is off when unset or blank', () => {
    expect(parseBoxEcrPull({})).toBeUndefined();
    expect(parseBoxEcrPull({ BOX_ECR_PULL_REPOSITORY_ARNS: ' , ' })).toBeUndefined();
  });

  it('reads the list, trimming and de-duplicating', () => {
    const cfg = parseBoxEcrPull({ BOX_ECR_PULL_REPOSITORY_ARNS: ` ${PUSHED[0]} ,${CACHE[0]},${PUSHED[0]}` });
    expect(cfg).toEqual({ repositoryArns: [PUSHED[0], CACHE[0]] });
  });

  it('fails closed on anything that is not an ECR repository ARN', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of ['*', 'arn:aws:s3:::bucket', 'arn:aws:ecr:us-east-1:123456789012:example-org/dev/*']) {
      expect(parseBoxEcrPull({ BOX_ECR_PULL_REPOSITORY_ARNS: `${PUSHED[0]},${bad}` }), bad).toBeUndefined();
    }
    err.mockRestore();
  });

  it('is carried on BoxConfig', () => {
    const cfg = getBoxConfig({
      AWS_REGION: 'us-east-2',
      AGENT_WS_URL: 'wss://termag.example.internal/termag/ws/agent',
      BOX_RESOURCE_PREFIX: 'termag-boxes',
      BOX_PERMISSIONS_BOUNDARY_ARN: 'arn:aws:iam::123456789012:policy/termag-boxes-boundary',
      BOX_VPC_ID: 'vpc-0123',
      BOX_SUBNET_ID: 'subnet-0123',
      ...ENV,
    });
    expect(cfg!.ecrPull!.repositoryArns).toHaveLength(4);
  });
});

describe('boxEcrPullPolicyDocument', () => {
  it('is one pull-only statement over the whole list, plus the auth token', () => {
    const doc = JSON.parse(boxEcrPullPolicyDocument(parseBoxEcrPull(ENV)!));
    expect(doc.Statement).toEqual([
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
        Resource: [...PUSHED, ...CACHE],
      },
    ]);
    const actions = doc.Statement.flatMap((s: { Action: string | string[] }) => [s.Action].flat());
    expect(actions.some((a: string) => /Put|Upload|Create|Delete|Describe/.test(a))).toBe(false);
  });
});

describe('ecrPullPolicyNeedsUpdate', () => {
  const desired = boxEcrPullPolicyDocument(parseBoxEcrPull(ENV)!);

  it('writes when the role has no policy or an unreadable one', () => {
    expect(ecrPullPolicyNeedsUpdate(undefined, desired)).toBe(true);
    expect(ecrPullPolicyNeedsUpdate('%7Bnot json', desired)).toBe(true);
  });

  it('skips a policy IAM returned URL-encoded and re-serialized', () => {
    const reordered = JSON.parse(desired);
    reordered.Statement = reordered.Statement.map((s: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(s).reverse()));
    const iamForm = encodeURIComponent(JSON.stringify(reordered, null, 2));
    expect(ecrPullPolicyNeedsUpdate(iamForm, desired)).toBe(false);
  });

  it('writes when the repository list changed', () => {
    const older = boxEcrPullPolicyDocument({ repositoryArns: PUSHED });
    expect(ecrPullPolicyNeedsUpdate(encodeURIComponent(older), desired)).toBe(true);
  });
});
