import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { environmentSchemaErrors } from './environmentSchema';

// The box runs an environment's steps (agent/environment-file.js);
// the schema (docs/environment.schema.json) is what a definition is checked against on save and when
// a file is read. The two must agree on setup, run, seed, stop, ports and secrets: what the schema takes
// the box runs without a warning, and what it refuses the box leaves out with one.
const require = createRequire(import.meta.url);
const { parseEnvironmentFile } = require('../../../agent/environment-file.js') as {
  parseEnvironmentFile: (text: string, ctx: Record<string, unknown>) => { warnings: string[]; setup: unknown[]; run: unknown[]; seed: unknown[]; ports: unknown[]; secrets: string[] };
};
const STEP_KEYS = ['setup', 'run', 'seed', 'stop', 'ports', 'secrets'];
const ctx = { fileRepo: 'acme/web', fileDir: '/w/web', checkouts: { 'acme/web': '/w/web', 'acme/api': '/w/api' } };
const schemaSays = (d: Record<string, unknown>) => environmentSchemaErrors(d).filter(e => STEP_KEYS.some(k => e.includes(k)));
const boxSays = (d: Record<string, unknown>) => parseEnvironmentFile(JSON.stringify(d), ctx).warnings;

const VALID: Array<[string, Record<string, unknown>]> = [
  ["termag's own file", JSON.parse(readFileSync(join(__dirname, '../../../.termag/environment.json'), 'utf8'))],
  ['a multi-repo definition with step maps', {
    repos: [{ repo: 'acme/web' }, { repo: 'acme/api', path: 'api' }],
    setup: { 'acme/api': 'go mod download', 'acme/web': 'pnpm install' },
    run: { 'acme/web': 'pnpm dev', 'acme/api': 'go run .' },
    seed: 'node scripts/seed.js',
    stop: { 'acme/api': 'docker compose down', 'acme/web': 'pkill -f vite' },
    ports: [{ name: 'web', port: 3000, health: '/health', path: '/app/' }, { name: 'api', port: 8080 }],
    secrets: ['APP_API_KEY', 'APP_SDK_KEY'],
  }],
];

const INVALID: Array<[string, Record<string, unknown>]> = [
  ['a step that is not a command', { setup: 42 }],
  ['an empty command', { run: '' }],
  ['a stop that is not a command', { stop: ['make', 'e2e-down'] }],
  ['a map entry that is not a command', { run: { 'acme/web': ['make'] } }],
  ['a map key that is not a repository', { setup: { 'not a repo': 'make' } }],
  ['a port that is not a number', { ports: [{ name: 'web', port: '80' }] }],
  ['a port out of range', { ports: [{ name: 'web', port: 70000 }] }],
  ['a health that is not a path', { ports: [{ name: 'web', port: 80, health: 'health' }] }],
  ['a page that is not a path', { ports: [{ name: 'web', port: 80, path: 'termag/' }] }],
  ['ports that are not a list', { ports: { name: 'web', port: 80 } }],
  ['a secret that is not a variable name', { secrets: ['not a name'] }],
  ['a lowercase secret name', { secrets: ['app_api_key'] }],
  ['secrets that are not a list', { secrets: 'APP_API_KEY' }],
];

describe("the box's steps and the schema agree", () => {
  it.each(VALID)('both take %s without a word', (_name, d) => {
    expect(schemaSays(d)).toEqual([]);
    expect(boxSays(d)).toEqual([]);
  });

  it.each(INVALID)('both refuse %s', (_name, d) => {
    expect(schemaSays(d).length).toBeGreaterThan(0);
    expect(boxSays(d).length).toBeGreaterThan(0);
  });

  it("is lenient only where the box can fill in: a port's name, which the schema requires", () => {
    expect(schemaSays({ ports: [{ port: 80 }] }).length).toBeGreaterThan(0);
    expect(parseEnvironmentFile(JSON.stringify({ ports: [{ port: 80 }] }), ctx).ports).toEqual([{ name: 'port 80', port: 80, health: null, path: '/' }]);
  });
});
