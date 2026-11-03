import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  COLLECTOR_CONFIG, COLLECTOR_ENDPOINT, COLLECTOR_INSTALLED, collectorExpected, deploymentEnvironment, orchestratorResource,
  otelConfigFromEnv, otelSetup, resetOtelSetupForTests,
} from './otel';

const none = () => false;
const collectorHere = (p: string) => p === COLLECTOR_CONFIG;

describe('otelSetup', () => {
  afterEach(() => resetOtelSetupForTests());

  it('looks again while there is nowhere to send, then keeps the config and one resource', () => {
    const dir = mkdtempSync(join(tmpdir(), 'otelsetup-'));
    try {
      const env = { TERMAG_OTELCOL_OUT: join(dir, 'destination.yaml') };
      // At boot the collector's config can appear after the backend starts.
      expect(otelSetup(env)).toBeNull();
      writeFileSync(env.TERMAG_OTELCOL_OUT, 'x');
      const first = otelSetup(env);
      expect(first?.config).toMatchObject({ endpoint: COLLECTOR_ENDPOINT, source: 'collector' });
      rmSync(env.TERMAG_OTELCOL_OUT);
      const again = otelSetup(env);
      expect(again?.config).toBe(first?.config);
      expect(again?.resource).toBe(first?.resource);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('collectorExpected', () => {
  const installed = (p: string) => p === COLLECTOR_INSTALLED;

  it('is true where the collector is installed and nothing overrides it', () => {
    expect(collectorExpected({}, installed)).toBe(true);
    expect(collectorExpected({}, none)).toBe(false);
    expect(collectorExpected({ TERMAG_OTEL: 'off' }, installed)).toBe(false);
    expect(collectorExpected({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://x' }, installed)).toBe(false);
    expect(collectorExpected({ TERMAG_OTELCOL_INSTALLED: '/tmp/c.yaml' }, p => p === '/tmp/c.yaml')).toBe(true);
  });
});

describe('otelConfigFromEnv', () => {
  it('is off with nowhere to send', () => {
    expect(otelConfigFromEnv({}, none)).toBeNull();
  });

  it('pushes to the host collector when it is configured here', () => {
    expect(otelConfigFromEnv({}, collectorHere)).toEqual({ endpoint: COLLECTOR_ENDPOINT, source: 'collector', exportIntervalMs: 60_000 });
  });

  it('prefers an explicit endpoint, without a trailing slash', () => {
    expect(otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/' }, collectorHere))
      .toMatchObject({ endpoint: 'https://otel.example', source: 'env' });
  });

  it('refuses an endpoint that is not http(s), and TERMAG_OTEL=off wins over everything', () => {
    expect(otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'grpc://x:4317' }, none)).toBeNull();
    expect(otelConfigFromEnv({ TERMAG_OTEL: 'off', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://x' }, collectorHere)).toBeNull();
  });

  it('takes a sane export interval and a moved collector config', () => {
    expect(otelConfigFromEnv({ OTEL_METRIC_EXPORT_INTERVAL: '15000' }, collectorHere)?.exportIntervalMs).toBe(15_000);
    expect(otelConfigFromEnv({ OTEL_METRIC_EXPORT_INTERVAL: '5' }, collectorHere)?.exportIntervalMs).toBe(60_000);
    expect(otelConfigFromEnv({ TERMAG_OTELCOL_OUT: '/tmp/x.yaml' }, p => p === '/tmp/x.yaml')?.source).toBe('collector');
  });
});

describe('orchestratorResource', () => {
  const SHA = 'a'.repeat(40);

  async function settled(env: NodeJS.ProcessEnv, version: Promise<string | null>) {
    const resource = orchestratorResource(env, version);
    await resource.waitForAsyncAttributes?.();
    return resource.attributes;
  }

  afterEach(() => { vi.unstubAllEnvs(); });

  it('carries the full running commit as service.version, and the environment', async () => {
    const attrs = await settled({ NODE_ENV: 'production' }, Promise.resolve(SHA));
    expect(attrs).toMatchObject({
      'service.name': 'termag-orchestrator',
      'service.version': SHA,
      'deployment.environment': 'production',
      'deployment.environment.name': 'production',
    });
    expect(attrs['service.instance.id']).toMatch(/:\d+$/);
  });

  it('holds exports until the commit resolves, rather than building without it', async () => {
    let resolve!: (sha: string) => void;
    const resource = orchestratorResource({}, new Promise(r => { resolve = r; }));
    expect(resource.asyncAttributesPending).toBe(true);
    resolve(SHA);
    await resource.waitForAsyncAttributes?.();
    expect(resource.attributes['service.version']).toBe(SHA);
  });

  it('leaves service.version out when the commit is unknown or its lookup fails', async () => {
    expect(await settled({}, Promise.resolve(null))).not.toHaveProperty('service.version');
    expect(await settled({}, Promise.reject(new Error('no git')))).not.toHaveProperty('service.version');
  });

  it('defaults the environment to development, and OTEL_RESOURCE_ATTRIBUTES wins', async () => {
    expect(deploymentEnvironment({})).toBe('development');
    expect(deploymentEnvironment({ NODE_ENV: ' Development ' })).toBe('development');
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'deployment.environment=staging,service.version=override');
    const attrs = await settled({ NODE_ENV: 'production' }, Promise.resolve(SHA));
    expect(attrs['deployment.environment']).toBe('staging');
    expect(attrs['service.version']).toBe('override');
  });
});
