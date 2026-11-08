import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nginxServerNameLine } from '../services/previewHostGrammar';
import { domainFromEnvFile, render } from './previewNginxSnippet';

describe('what root runs', () => {
  // The bake copies only this script and previewHostGrammar.js to a root-owned
  // directory (packer/scripts/orchestrator-setup.sh): neither may import more.
  const importsOf = (file: string) =>
    [...readFileSync(join(__dirname, file), 'utf8').matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);

  it('imports only builtins and the grammar module', () => {
    expect(importsOf('previewNginxSnippet.ts')).toEqual(['child_process', 'fs', '../services/previewHostGrammar']);
    expect(importsOf('../services/previewHostGrammar.ts')).toEqual([]);
  });
});

describe('domainFromEnvFile', () => {
  it('reads the one line, as cloud-init writes it', () => {
    expect(domainFromEnvFile('A=1\nPREVIEW_LINKS_DOMAIN=previews.test\nB=2\n')).toBe('previews.test');
    expect(domainFromEnvFile("PREVIEW_LINKS_DOMAIN='previews.test'")).toBe('previews.test');
    expect(domainFromEnvFile('export PREVIEW_LINKS_DOMAIN="previews.test"')).toBe('previews.test');
    expect(domainFromEnvFile('PREVIEW_LINKS_DOMAIN=previews.test # the zone')).toBe('previews.test');
    expect(domainFromEnvFile("PREVIEW_LINKS_DOMAIN='previews.test' # the zone")).toBe('previews.test');
    expect(domainFromEnvFile('PREVIEW_LINKS_DOMAIN="previews.test"   # the zone')).toBe('previews.test');
    expect(domainFromEnvFile('PREVIEW_LINKS_DOMAIN=a.test\nPREVIEW_LINKS_DOMAIN=b.test')).toBe('b.test');
    expect(domainFromEnvFile('PREVIEW_LINKS_DOMAIN=')).toBe('');
    expect(domainFromEnvFile('# PREVIEW_LINKS_DOMAIN=previews.test\nX_PREVIEW_LINKS_DOMAIN=previews.test')).toBeUndefined();
  });
});

describe('render', () => {
  let dir: string;
  let logs: string[];
  const run = (env: NodeJS.ProcessEnv) =>
    render({ env: { TERMAG_PREVIEW_SNIPPET: join(dir, 'termag-preview-server-name.conf'), TERMAG_NGINX_TEST: '', ...env }, log: (l) => logs.push(l) });
  const snippet = () => join(dir, 'termag-preview-server-name.conf');

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'preview-nginx-')); logs = []; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the generated line from the .env, without reading anything else in it', () => {
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'SESSION_SECRET=$(touch pwned)\nPREVIEW_LINKS_DOMAIN=Previews.Test\n');
    expect(run({ TERMAG_ENV_FILE: envFile }).kind).toBe('written');
    expect(readFileSync(snippet(), 'utf8')).toBe(nginxServerNameLine('previews.test'));
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
  });

  it('the process environment wins over the file', () => {
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'PREVIEW_LINKS_DOMAIN=other.test\n');
    run({ TERMAG_ENV_FILE: envFile, PREVIEW_LINKS_DOMAIN: 'previews.test' });
    expect(readFileSync(snippet(), 'utf8')).toBe(nginxServerNameLine('previews.test'));
  });

  it('unset: no snippet, a stale one removed, and no failure', () => {
    writeFileSync(snippet(), 'server_name stale;\n');
    expect(run({ TERMAG_ENV_FILE: join(dir, 'missing.env') }).kind).toBe('unset');
    expect(existsSync(snippet())).toBe(false);
    expect(run({ PREVIEW_LINKS_DOMAIN: '  ' }).kind).toBe('unset');
    expect(logs.join('\n')).toMatch(/unset/);
  });

  it('malformed: refuses, removes a stale snippet, and logs without echoing the value', () => {
    writeFileSync(snippet(), 'server_name stale;\n');
    const evil = 'previews.test"; return 200; #';
    expect(run({ PREVIEW_LINKS_DOMAIN: evil }).kind).toBe('malformed');
    expect(existsSync(snippet())).toBe(false);
    expect(logs.join('\n')).toMatch(/ERROR: PREVIEW_LINKS_DOMAIN is set but is not a domain/);
    expect(logs.join('\n')).not.toContain(evil);
  });

  it('removes the snippet again when nginx -t refuses it', () => {
    const r = run({ PREVIEW_LINKS_DOMAIN: 'previews.test', TERMAG_NGINX_TEST: 'echo "emerg: no" >&2; exit 1' });
    expect(r).toEqual({ kind: 'nginx_refused', output: 'emerg: no' });
    expect(existsSync(snippet())).toBe(false);
    expect(logs.join('\n')).toMatch(/nginx refused/);
  });
});
