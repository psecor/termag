// Which GitHub repository a review is of. A bare PR number means nothing
// without one: in a directory with no git remote `gh pr view 342` fails, and a
// reviewer left to guess picks among whatever clones it can find (a review
// meant for termag#342 was once posted on webapp#342 that way). So the
// Review route asks the workstream's checkout for its `origin` and names the
// repository in the prompt; with no GitHub remote, a bare number is refused
// and the dialog asks for the PR's URL instead.
//
// The remote comes from the `git-branch-state` RPC (agent/git-branch-state.js)
// and, on an agent that predates it, from the checkout's git config read with
// `read-file`, which every agent has: `.git/config`, or for a worktree (`.git`
// is a file) the config of the repository it belongs to.
import type { ProjectHost } from './agentRegistry';
import { repoFromOrigin } from './prBranches';
import { GITHUB_PR_URL, type SendForHost } from './review';

/**
 * `known: false` — the remote could not be read (agent offline mid-call, an
 * unreadable config): say nothing either way. `known: true, repo: null` — the
 * directory is not a checkout, or its origin is missing or not on GitHub.
 */
export interface WorkstreamRepo {
  repo: string | null;
  known: boolean;
}

/** `owner/name` from a GitHub PR URL. */
export function repoFromPrUrl(url: string | null | undefined): string | null {
  if (!url || !GITHUB_PR_URL.test(url)) return null;
  const [, , , owner, name] = url.split('/');
  return `${owner}/${name}`;
}

export function prUrlFor(repo: string, pr: number): string {
  return `https://github.com/${repo}/pull/${pr}`;
}

/**
 * The `url` of origin in a git config file. `[remote "origin"]` (the
 * subsection name is case-sensitive, so `"ORIGIN"` is another remote) or the
 * deprecated `[remote.origin]`. `includes` is set when the file pulls in
 * other config (`[include]` / `[includeIf …]`): a URL may come from there, so
 * no origin here does not mean no remote.
 */
export function originFromGitConfig(text: string): { url: string | null; includes: boolean } {
  let inOrigin = false;
  let includes = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (section) {
      const name = section[1];
      inOrigin = (/^remote\s+"origin"$/i.test(name) && name.endsWith('"origin"')) || /^remote\.origin$/i.test(name);
      if (/^include(?:if\b|$)/i.test(name)) includes = true;
      continue;
    }
    if (!inOrigin) continue;
    const kv = /^url\s*=\s*(.+)$/i.exec(line);
    if (kv) return { url: kv[1].trim().replace(/^"(.*)"$/, '$1'), includes };
  }
  return { url: null, includes };
}

/** Join a path the way git does for `gitdir:` / `commondir`: relative to `base`. */
function resolveFrom(base: string, p: string): string {
  const parts = (p.startsWith('/') ? p : `${base.replace(/\/+$/, '')}/${p}`).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return `/${out.join('/')}`;
}

/** Each fallback read; three can run back to back, inside a start request. */
const READ_TIMEOUT_MS = 2000;

async function originFromFiles(send: SendForHost, host: ProjectHost, cwd: string): Promise<WorkstreamRepo> {
  const read = async (path: string): Promise<string | null> => {
    const r = await send(host, 'read-file', { path }, READ_TIMEOUT_MS);
    return typeof r?.content === 'string' ? r.content : null;
  };
  const dir = cwd.replace(/\/+$/, '');
  let config: string | null = null;
  try {
    config = await read(`${dir}/.git/config`);
  } catch {
    // ENOTDIR: `.git` is a file, i.e. a worktree (or submodule) pointing elsewhere.
    const pointer = await read(`${dir}/.git`);
    const gitdir = pointer && /^gitdir:\s*(.+)$/m.exec(pointer)?.[1].trim();
    if (!gitdir) return { repo: null, known: true };
    const worktreeDir = resolveFrom(dir, gitdir);
    const common = (await read(`${worktreeDir}/commondir`))?.trim();
    config = await read(`${common ? resolveFrom(worktreeDir, common) : worktreeDir}/config`);
  }
  if (config == null) return { repo: null, known: true }; // not a checkout
  const { url, includes } = originFromGitConfig(config);
  // An origin that may live in an included file is not known to be absent.
  if (!url) return { repo: null, known: !includes };
  return { repo: repoFromOrigin(url), known: true };
}

export async function workstreamRepo(send: SendForHost, host: ProjectHost, cwd: string): Promise<WorkstreamRepo> {
  try {
    const r = await send(host, 'git-branch-state', { cwd }, 10_000);
    return { repo: repoFromOrigin(r?.origin), known: true };
  } catch {
    // An agent without the RPC, a slow repo, or no checkout at all (which
    // fails `git status` too): the files below tell those apart.
  }
  try {
    return await originFromFiles(send, host, cwd);
  } catch {
    return { repo: null, known: false };
  }
}

/**
 * The repository a review start is for: the PR URL's when one came with it,
 * else the workstream's. `refuse` when there is neither and the workstream is
 * known to have no GitHub remote; when the remote could not be read the
 * review starts as it always did (the reviewer asks gh in the directory).
 */
export function reviewTarget(pr: number, url: string | null, ws: WorkstreamRepo):
  { url: string | null; repo: string | null; mismatch: string | null } | { refuse: string } {
  const fromUrl = repoFromPrUrl(url);
  if (fromUrl) {
    const mismatch = ws.repo && ws.repo.toLowerCase() !== fromUrl.toLowerCase() ? ws.repo : null;
    return { url, repo: fromUrl, mismatch };
  }
  if (ws.repo) return { url: prUrlFor(ws.repo, pr), repo: ws.repo, mismatch: null };
  if (ws.known) {
    return { refuse: `This workstream's directory has no GitHub remote, so PR #${pr} could be in any repository. Paste the PR's URL or type owner/repo#${pr}.` };
  }
  return { url: null, repo: null, mismatch: null };
}
