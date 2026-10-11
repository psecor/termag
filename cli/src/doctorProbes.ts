import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** What `termag ssh` needs in ~/.aws/config: the boxes' account (TERMAG_AWS_ACCOUNT, as connect/awsConfig.ts writes it). */
export const AWS_PROFILE = process.env.TERMAG_AWS_PROFILE || 'termag-boxes';
export const TERMAG_ACCOUNT = process.env.TERMAG_AWS_ACCOUNT || '123456789012';
export const TERMAG_ROLE = 'TermagUser';

/** `SHA256:<unpadded base64>` of an OpenSSH public key line, as `ssh-keygen -l` and the orchestrator print it. */
export function sshKeyFingerprint(line: string): string | null {
  const [type, b64] = line.trim().split(/[ \t]+/);
  if (!type || !b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const blob = Buffer.from(b64, 'base64');
  if (blob.length < 4) return null;
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

/** The keys of one `[profile <name>]` section (`[default]` for "default"), or null when there is none. */
export function awsProfileSection(text: string | null, name: string): Record<string, string> | null {
  if (!text) return null;
  const header = name === 'default' ? /^\[\s*(profile\s+)?default\s*\]$/ : new RegExp(`^\\[\\s*profile\\s+${name.replace(/[-.]/g, '\\$&')}\\s*\\]$`);
  let section: Record<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      if (section) return section;
      if (header.test(line)) section = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (section && eq > 0) section[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return section;
}

export interface GhApiResponse {
  status: number | null;
  /** The X-GitHub-SSO header: `required; url=…` when the token isn't authorized for the org's SSO. */
  sso: string | null;
}

/** Status and SSO header from `gh api --include` output. */
export function parseGhInclude(stdout: string): GhApiResponse {
  const lines = stdout.split(/\r?\n/);
  const m = /^HTTP\/[\d.]+\s+(\d{3})/.exec(lines[0] ?? '');
  let sso: string | null = null;
  for (const line of lines.slice(1)) {
    if (!line.trim()) break;
    const h = /^x-github-sso:\s*(.*)$/i.exec(line);
    if (h) sso = h[1].trim();
  }
  return { status: m ? Number(m[1]) : null, sso };
}

export function ssoAuthorizeUrl(header: string | null): string | null {
  const m = header ? /url=(\S+)/.exec(header) : null;
  return m ? m[1].replace(/[;,]$/, '') : null;
}

export type ReadFile = (path: string) => string | null;
export type ListDir = (path: string) => string[];

function globToRegExp(glob: string): RegExp {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

/** The first line of the block `termag ssh-config --install` writes. */
export const SSH_CONFIG_MARKER = '# >>> termag ssh-config >>>';

export interface TermagSshHost {
  path: string;
  /** Inside the block `termag ssh-config --install` manages, rather than written by hand. */
  managed: boolean;
}

/**
 * Where ~/.ssh/config (or a file it Includes) has a `Host` line matching
 * `termag-*`, the entry `termag ssh-config --install` adds.
 */
export function findTermagSshHost(home: string, read: ReadFile, list: ListDir): TermagSshHost | null {
  const sshDir = join(home, '.ssh');
  const seen = new Set<string>();
  const visit = (path: string, depth: number): TermagSshHost | null => {
    if (seen.has(path) || depth > 4) return null;
    seen.add(path);
    const text = read(path);
    if (!text) return null;
    let managed = false;
    for (const raw of text.split(/\r?\n/)) {
      if (raw.trim() === SSH_CONFIG_MARKER) managed = true;
      const line = raw.replace(/#.*$/, '').trim();
      const host = /^host\s+(.+)$/i.exec(line);
      if (host && host[1].split(/\s+/).some(p => p === 'termag-*' || (p.startsWith('termag-') && !p.startsWith('!')))) return { path, managed };
      const inc = /^include\s+(.+)$/i.exec(line);
      if (!inc) continue;
      for (const pattern of inc[1].split(/\s+/)) {
        const abs = pattern.startsWith('~/') ? join(home, pattern.slice(2)) : pattern.startsWith('/') ? pattern : join(sshDir, pattern);
        const slash = abs.lastIndexOf('/');
        const dir = abs.slice(0, slash);
        const base = abs.slice(slash + 1);
        const names = /[*?]/.test(base) ? list(dir).filter(n => globToRegExp(base).test(n)).sort() : [base];
        for (const n of names) {
          const found = visit(join(dir, n), depth + 1);
          if (found) return found;
        }
      }
    }
    return null;
  };
  return visit(join(sshDir, 'config'), 0);
}
