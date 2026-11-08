/**
 * Renders nginx's preview `server_name` from PREVIEW_LINKS_DOMAIN.
 * On the orchestrator it
 * runs as root before every nginx start (deploy/termag-preview-nginx.conf, a
 * drop-in for nginx.service), after cloud-init has written the backend's .env,
 * from a root-owned copy the bake installs (packer/scripts/orchestrator-setup.sh):
 *
 *   node /usr/local/lib/termag/preview-nginx/scripts/previewNginxSnippet.js
 *
 * That copy holds this file and services/previewHostGrammar.js only, so this
 * imports nothing else but Node's builtins (previewNginxSnippet.test.ts pins it).
 *
 * - Domain set and well formed: writes
 *   /etc/nginx/snippets/termag-preview-server-name.conf, the line
 *   previewHostGrammar.nginxServerNameLine builds (the label grammar the
 *   backend checks, the domain regex-escaped, the whole regex quoted), then
 *   runs `nginx -t`; if nginx refuses it, the snippet is removed again.
 * - Unset: no snippet (a stale one is removed), and the preview server block
 *   matches nothing but termag-preview.invalid. Exit 0.
 * - Malformed: no snippet either, an error on stderr (the nginx unit's
 *   journal), exit 1. The unit runs this with `-`, so nginx starts regardless.
 *
 * The domain is read from the .env file, never by sourcing it: only the one
 * PREVIEW_LINKS_DOMAIN line, so nothing else in that file (secrets) is touched.
 * The process environment's PREVIEW_LINKS_DOMAIN wins when set, for tests.
 *
 * Paths: TERMAG_ENV_FILE (default /opt/termag/backend/.env),
 * TERMAG_PREVIEW_SNIPPET (default the snippet path above), TERMAG_NGINX_TEST
 * (the command for the check, default `nginx -t -q`; empty skips it).
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { normalisePreviewDomain, nginxServerNameLine, previewDomainRefusal } from '../services/previewHostGrammar';

export const DEFAULT_ENV_FILE = '/opt/termag/backend/.env';
export const DEFAULT_SNIPPET = '/etc/nginx/snippets/termag-preview-server-name.conf';
const TAG = 'termag-preview-nginx';

/**
 * PREVIEW_LINKS_DOMAIN's value in a .env file as cloud-init writes it
 * (`KEY=value` or `KEY='value'`, dotenv's `export`, double quotes and a
 * trailing ` # comment` too).
 * The last assignment wins, as dotenv's does. Undefined when absent.
 */
export function domainFromEnvFile(text: string): string | undefined {
  let value: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?PREVIEW_LINKS_DOMAIN\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const v = m[1];
    // A quoted value ends at its closing quote, and an inline comment may
    // follow it, as dotenv reads it; unquoted, a ` #` starts the comment.
    const q = /^(['"`])(.*?)\1(?:\s+#.*)?$/.exec(v);
    value = q ? q[2] : v.replace(/\s+#.*$/, '');
  }
  return value;
}

export type RenderResult =
  | { kind: 'written'; line: string }
  | { kind: 'unset' }
  | { kind: 'malformed' }
  | { kind: 'nginx_refused'; output: string };

export interface RenderEnv {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

function readDomain(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PREVIEW_LINKS_DOMAIN !== undefined) return env.PREVIEW_LINKS_DOMAIN;
  const file = env.TERMAG_ENV_FILE || DEFAULT_ENV_FILE;
  if (!existsSync(file)) return undefined;
  return domainFromEnvFile(readFileSync(file, 'utf8'));
}

function nginxTest(env: NodeJS.ProcessEnv): { ok: true } | { ok: false; output: string } {
  const cmd = env.TERMAG_NGINX_TEST ?? 'nginx -t -q';
  if (!cmd.trim()) return { ok: true };
  const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
  if (r.status === 0) return { ok: true };
  return { ok: false, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`.trim() };
}

export function render({ env, log }: RenderEnv): RenderResult {
  const snippet = env.TERMAG_PREVIEW_SNIPPET || DEFAULT_SNIPPET;
  const domain = normalisePreviewDomain(readDomain(env));
  const refusal = previewDomainRefusal(domain);
  if (refusal) {
    // Whatever an earlier boot wrote is not this configuration's.
    rmSync(snippet, { force: true });
    if (refusal === 'unset') {
      log(`${TAG}: PREVIEW_LINKS_DOMAIN is unset: no preview server_name, preview hosts match nothing`);
      return { kind: 'unset' };
    }
    // The value itself is not logged: it is unescaped, and it is a setting the reader can look up.
    log(`${TAG}: ERROR: PREVIEW_LINKS_DOMAIN is set but is not a domain (two or more DNS labels of a-z, 0-9 and -): no snippet written, preview hosts match nothing`);
    return { kind: 'malformed' };
  }
  const line = nginxServerNameLine(domain as string);
  const tmp = `${snippet}.tmp-${process.pid}`;
  // The tmp name doesn't end in .conf, so the block's glob never includes a half-written file.
  writeFileSync(tmp, line, { mode: 0o644 });
  renameSync(tmp, snippet);
  const t = nginxTest(env);
  if (!t.ok) {
    rmSync(snippet, { force: true });
    log(`${TAG}: ERROR: nginx refused the rendered preview server_name, removed it: ${t.output}`);
    return { kind: 'nginx_refused', output: t.output };
  }
  log(`${TAG}: wrote ${snippet}`);
  return { kind: 'written', line };
}

if (require.main === module) {
  const r = render({ env: process.env, log: (l) => console.error(l) });
  process.exit(r.kind === 'written' || r.kind === 'unset' ? 0 : 1);
}
