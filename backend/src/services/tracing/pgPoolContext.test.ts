import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

const backend = join(__dirname, '..', '..', '..');

describe('PgPoolContextInstrumentation', () => {
  it('runs a queued pg-pool connect callback in its own caller\'s context', () => {
    // Without a database: pg-pool over a fake client, in a child process
    // (fixtures/pgPoolContext.ts). sessionContext.integration.test.ts shows
    // what an unbound callback does to real requests.
    const r = spawnSync(join(backend, 'node_modules', '.bin', 'tsx'), [join(__dirname, 'fixtures', 'pgPoolContext.ts')], {
      cwd: backend,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DOTENV_CONFIG_PATH: '/dev/null' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').pop()!)).toEqual({ first: 'first', second: 'second' });
  });
});
