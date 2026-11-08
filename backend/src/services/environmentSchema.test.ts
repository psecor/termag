import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { environmentSchemaErrors } from './environmentSchema';
import { parseRepoEnvironment } from './repoEnvironment';

// docs/environment.schema.json, the environment definition's schema:
// the design's examples pass, its limits hold, and
// the orchestrator's copy is the docs one.

// The design's "The file" example (termag's own) and "webapp's equivalent file", plus the repos list.
const TERMAG = {
  resources: { vcpu: 4, memoryGiB: 32 },
  setup: 'bash .cursor/install.sh',
  run: 'bash .cursor/start.sh',
  ports: [
    { name: 'frontend', port: 5174, health: '/termag/' },
    { name: 'backend', port: 3040, health: '/api/health' },
  ],
  seed: 'bash scripts/e2e/seed.sh',
};
const WEBAPP = {
  $schema: 'https://github.com/example-org/termag/blob/main/docs/environment.schema.json',
  resources: { vcpu: 4, memoryGiB: 32 },
  setup: 'bash .termag/setup.sh',
  run: 'DEV_NONINTERACTIVE=1 make dev',
  slots: { max: 8 },
  env: { DEV_INSTANCE: '${slot}' },
  envFile: 'dev-stack/.env.override',
  host: '127.0.0.${slot}',
  ports: [
    { name: 'app', port: 80, health: '/' },
    { name: 'assets', port: { base: 3002, step: 10 } },
    { name: 'dev-server', port: 8765 },
  ],
  secrets: ['APP_API_KEY'],
};

describe('docs/environment.schema.json', () => {
  it("is the orchestrator's copy, byte for byte", () => {
    const docs = readFileSync(join(__dirname, '../../../docs/environment.schema.json'), 'utf8');
    expect(readFileSync(join(__dirname, 'environment.schema.json'), 'utf8')).toBe(docs);
  });

  it("takes the design's examples: termag's own file and webapp's", () => {
    expect(environmentSchemaErrors(TERMAG)).toEqual([]);
    expect(environmentSchemaErrors(WEBAPP)).toEqual([]);
  });

  // The repo's demo environment (docs/e2e-stack.md, "A demo environment"), read as a pointer reads it.
  it('takes .termag/demo/environment.json, and reads it as a small box with a 50 GB disk and no warning', () => {
    const text = readFileSync(join(__dirname, '../../../.termag/demo/environment.json'), 'utf8');
    expect(environmentSchemaErrors(JSON.parse(text))).toEqual([]);
    const parsed = parseRepoEnvironment(text, 'example-org/termag', '.termag/demo/environment.json');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.sizes).toEqual({ size: { vcpu: 2, memoryGiB: 8 }, diskGiB: 50 });
  });

  // Spaces are always on, so the stack needs E2E_SPACES=1 for its bucket and KMS alias, or every upload's PUT is a NoSuchBucket.
  it("brings the demo's stack up with the spaces bucket", () => {
    const run = JSON.parse(readFileSync(join(__dirname, '../../../.termag/demo/environment.json'), 'utf8')).run as string;
    expect(run.split(/\s+/)).toContain('E2E_SPACES=1');
  });

  it('takes repos, presets, disk, step maps, base and unknown keys', () => {
    expect(environmentSchemaErrors({
      repos: ['example-org/webapp', { repo: 'example-org/web', branch: 'main', path: 'frontend' }],
      resources: { vcpu: 8, memoryGiB: 32, diskGiB: 300 },
      base: 'empty',
      setup: { 'example-org/webapp': 'bash .termag/setup.sh', 'example-org/web': 'pnpm install' },
      somethingNew: true,
    })).toEqual([]);
    expect(environmentSchemaErrors({ resources: 'small' })).toEqual([]);
  });

  it("says one thing per place: a value no branch of a oneOf takes reads as one line, not one per branch", () => {
    expect(environmentSchemaErrors({ ports: [{ name: 'web', port: 70000 }] })).toEqual(['ports.0.port must be <= 65535']);
  });

  it.each([
    [{ resources: { vcpu: 9, memoryGiB: 32 } }, /resources.vcpu must be <= 8/],
    [{ resources: { vcpu: 4, memoryGiB: 33 } }, /resources.memoryGiB must be <= 32/],
    [{ resources: { vcpu: 4, memoryGiB: 16, diskGiB: 40 } }, /resources.diskGiB must be >= 50/],
    [{ resources: { vcpu: 4, memoryGiB: 16, diskGiB: 301 } }, /resources.diskGiB must be <= 300/],
    [{ resources: 'huge' }, /resources must be one of "small", "medium", "large"/],
    [{ base: 'tiny' }, /base must be one of "full", "empty"/],
    [{ setup: 3 }, /setup must be/],
    [{ run: { 'not a repo': 'make' } }, /run/],
    [{ ports: [{ name: 'web', port: { base: 3000 } }] }, /ports.0.port must have required property 'step'/],
    [{ ports: [{ name: 'web', port: 80, health: 'api' }] }, /ports.0.health must match pattern/],
    [{ secrets: ['lower-case'] }, /secrets.0 must match pattern/],
    [{ slots: { max: 9 } }, /slots.max must be <= 8/],
    [{ env: { A: 1 } }, /env.A must be string/],
    [{ repos: [{ repo: 'a/b', extra: 1 }] }, /has "extra"/],
  ])('refuses %j', (data, why) => {
    const errors = environmentSchemaErrors(data);
    expect(errors.join('\n')).toMatch(why);
  });
});
