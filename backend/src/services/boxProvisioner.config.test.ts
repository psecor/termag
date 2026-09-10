import { describe, it, expect } from 'vitest';
import { getBoxConfig, awsClientConfig, revokeTargets } from './boxProvisioner';

const REQUIRED = {
  AWS_REGION: 'us-east-1',
  AGENT_WS_URL: 'wss://termag.example.internal/termag/ws/agent',
  BOX_RESOURCE_PREFIX: 'development-termag-box',
  BOX_PERMISSIONS_BOUNDARY_ARN: 'arn:aws:iam::123456789012:policy/development-termag-box-boundary',
  BOX_VPC_ID: 'vpc-0123',
  BOX_SUBNET_ID: 'subnet-0123',
};

describe('getBoxConfig', () => {
  it('is null until every required variable is present', () => {
    expect(getBoxConfig({})).toBeNull();
    for (const key of Object.keys(REQUIRED)) {
      const env = { ...REQUIRED } as Record<string, string>;
      delete env[key];
      expect(getBoxConfig(env), `missing ${key}`).toBeNull();
    }
  });

  it('no longer requires HOST_SECURITY_GROUP_ID (off-host orchestrators have no host SG)', () => {
    const cfg = getBoxConfig(REQUIRED);
    expect(cfg).not.toBeNull();
    expect(cfg!.hostSecurityGroupId).toBeUndefined();
    expect(cfg!.assumeRoleArn).toBeUndefined();
  });

  it('carries the host SG and provisioner role when set, ignoring blanks', () => {
    const cfg = getBoxConfig({
      ...REQUIRED,
      HOST_SECURITY_GROUP_ID: ' sg-abc ',
      BOX_PROVISIONER_ROLE_ARN: 'arn:aws:iam::123456789012:role/development-termag-box-provisioner',
    });
    expect(cfg!.hostSecurityGroupId).toBe('sg-abc');
    expect(cfg!.assumeRoleArn).toBe('arn:aws:iam::123456789012:role/development-termag-box-provisioner');

    const blank = getBoxConfig({ ...REQUIRED, HOST_SECURITY_GROUP_ID: '', BOX_PROVISIONER_ROLE_ARN: '   ' });
    expect(blank!.hostSecurityGroupId).toBeUndefined();
    expect(blank!.assumeRoleArn).toBeUndefined();
  });

  it('applies defaults for instance type, tag, and root volume', () => {
    const cfg = getBoxConfig(REQUIRED)!;
    expect(cfg.instanceType).toBe('t4g.medium');
    expect(cfg.managedTag).toBe('termag-box');
    expect(cfg.rootVolumeGb).toBe(120);
  });
});

describe('awsClientConfig', () => {
  it('uses ambient credentials when no provisioner role is configured', () => {
    expect(awsClientConfig({ region: 'us-east-1' })).toEqual({ region: 'us-east-1' });
  });

  it('honours a per-instance region override', () => {
    expect(awsClientConfig({ region: 'us-east-1' }, 'us-west-2')).toEqual({ region: 'us-west-2' });
  });

  it('attaches an assume-role credential provider when a provisioner role is configured', () => {
    const cfg = awsClientConfig({
      region: 'us-east-1',
      assumeRoleArn: 'arn:aws:iam::123456789012:role/development-termag-box-provisioner',
    });
    expect(cfg.region).toBe('us-east-1');
    expect(typeof cfg.credentials).toBe('function');
  });
});

describe('revokeTargets', () => {
  it('falls back to the configured host SG when discovery found nothing', () => {
    expect(revokeTargets('sg-host', [], 'sg-box')).toEqual(['sg-host']);
  });

  it('revokes from every referencing SG with HOST_SECURITY_GROUP_ID unset (container orchestrator tearing down an EC2-era box)', () => {
    expect(revokeTargets(undefined, ['sg-oldhost', 'sg-other'], 'sg-box')).toEqual(['sg-oldhost', 'sg-other']);
  });

  it('de-duplicates the configured host SG against the discovered set', () => {
    expect(revokeTargets('sg-host', ['sg-host', 'sg-other'], 'sg-box')).toEqual(['sg-host', 'sg-other']);
  });

  it('never targets the box SG itself and is empty when there is nothing to revoke', () => {
    expect(revokeTargets(undefined, ['sg-box'], 'sg-box')).toEqual([]);
    expect(revokeTargets('sg-box', [], 'sg-box')).toEqual([]);
    expect(revokeTargets(undefined, [], 'sg-box')).toEqual([]);
  });
});
