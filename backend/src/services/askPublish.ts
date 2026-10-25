/**
 * Publishing an ask run's commits. The box uploads a git bundle of the branches the run made on
 * top of the thread's base commit; this module checks it in a throwaway bare
 * repository, pushes each branch without force, and opens (or finds) a draft
 * PR for each: the run's own branch on `termag-<asker>/<thread>`, each of its
 * `pr/<key>` branches on `termag-<asker>/<thread>-<key>` ("Several PRs").
 *
 * It runs on the orchestrator, which the run cannot touch, with the asker's
 * own stored GitHub token: GitHub then checks the asker's access, and the PR
 * is theirs. The run itself holds the box token (a decision, see the doc), so
 * these checks bind runs that go through this path, not one that goes around it.
 *
 * Checks that refuse the whole bundle: one to MAX_ASK_PRS heads, each the
 * run's own branch or a pr/<key>; it applies on the base; at most MAX_COMMITS
 * commits in all. Checks that refuse one branch, leaving the others to
 * publish: it descends from the base; no merge commit; no protected path
 * touched; every commit authored and committed as the asker; no secret-shaped
 * string added; a new key beyond the thread's MAX_ASK_PRS.
 *
 * A PR's description is the one the run wrote for that branch, if any, else
 * one built from the branch's commit messages. A run's description with a
 * secret-shaped string in it is dropped, never published. Every publish
 * rewrites the marked part of the body, so a follow-up turn's description or
 * commits show up on the PR.
 */
import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MAX_ASK_PRS, askPrKeyOfRef, capDescription, commitDescription, replaceMarkedBody, splitDescription } from './agentMessages';

export const MAX_COMMITS = 200;

const PROTECTED: Array<{ re: RegExp; what: string }> = [
  { re: /^\.github\/workflows\//, what: '.github/workflows' },
  { re: /(^|\/)CODEOWNERS$/, what: 'CODEOWNERS' },
  { re: /^deploy\//, what: 'deploy/' },
  { re: /(^|\/)sudoers$/, what: 'sudoers' },
  { re: /(^|\/)sudoers\.d\//, what: 'sudoers.d' },
];

/** The protected area a path is in, or null. */
export function protectedArea(path: string): string | null {
  for (const p of PROTECTED) if (p.re.test(path)) return p.what;
  return null;
}

const SECRETS: Array<{ re: RegExp; what: string }> = [
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'AWS access key id' },
  { re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/, what: 'GitHub token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/, what: 'GitHub token' },
  { re: /\btmag_[A-Za-z0-9]{16,}\b/, what: 'termag agent token' },
  { re: /\btmcli_[A-Za-z0-9]{16,}\b/, what: 'termag CLI token' },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, what: 'Slack token' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, what: 'Anthropic key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'private key' },
];

/**
 * The kinds of secret-shaped strings among the lines a diff adds. `+++` lines
 * are scanned too: an added line that starts with `++` looks the same.
 */
export function findSecrets(diff: string): string[] {
  const found = new Set<string>();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+')) continue;
    for (const s of SECRETS) if (s.re.test(line)) found.add(s.what);
  }
  return [...found];
}

/** The kinds of secret-shaped strings on any line of a text, such as commit messages. */
export function findSecretsInText(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split('\n')) for (const s of SECRETS) if (s.re.test(line)) found.add(s.what);
  return [...found];
}

export interface PublishInput {
  bundle: Buffer;
  baseSha: string;
  /** owner/name on github.com. */
  repo: string;
  token: string;
  askerEmail: string;
  /** The GitHub branch a PR key publishes to ('' is the run's own branch). */
  branchFor: (key: string) => string;
  /** The whole PR body around a description (agentMessages prBody). */
  prBody: (description: string, key: string) => string;
  /** What the run wrote for each branch's PR (untrusted), by key. */
  prDescriptions: Record<string, string>;
  /** The PRs the thread already has, by key: a push to one updates it. */
  prNumbers: Record<string, number>;
}

export interface PublishConfig {
  /** Where `<owner>/<name>.git` is fetched from and pushed to; https://github.com in production. */
  gitBaseUrl: string;
  apiBaseUrl: string;
  fetch: typeof fetch;
}

/** What became of one branch of the bundle. */
export type PrOutcome =
  | {
    kind: 'published'; key: string; branch: string; headSha: string; commits: number; prNumber: number; prUrl: string; prCreated: boolean;
    /** Something about the description a person should know: dropped, or not updated. */
    note?: string;
  }
  | { kind: 'refused' | 'failed'; key: string; branch: string; reason: string };

export type PublishOutcome =
  | { kind: 'done'; prs: PrOutcome[] }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; reason: string };

/**
 * A publish as agent_messages.publish / publishDetail: `published` when every
 * branch was, `partial` when some were, else `refused` or `failed` (failed if
 * any branch failed). The detail names the branches only when there are several.
 */
export function publishSummary(o: PublishOutcome): { publish: 'published' | 'partial' | 'refused' | 'failed'; detail: string } {
  if (o.kind !== 'done') return { publish: o.kind, detail: o.reason };
  const many = o.prs.length > 1;
  const line = (p: PrOutcome) => {
    const what = p.kind === 'published'
      ? `${p.commits} commit(s) at ${p.headSha.slice(0, 12)} on ${p.branch}${p.note ? `; ${p.note}` : ''}`
      : p.reason;
    return many ? `${p.key ? `pr/${p.key}` : 'ask'}: ${what}` : what;
  };
  const ok = o.prs.filter(p => p.kind === 'published').length;
  const publish = ok === o.prs.length ? 'published' : ok ? 'partial' : o.prs.some(p => p.kind === 'failed') ? 'failed' : 'refused';
  return { publish, detail: o.prs.map(line).join(' | ') };
}

export function publishConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PublishConfig {
  return {
    gitBaseUrl: (env.ASK_GITHUB_GIT_URL?.trim() || 'https://github.com').replace(/\/+$/, ''),
    apiBaseUrl: (env.ASK_GITHUB_API_URL?.trim() || 'https://api.github.com').replace(/\/+$/, ''),
    fetch,
  };
}

class GitError extends Error {
  constructor(message: string, readonly stderr: string) { super(message); }
}

/** A git failure's last stderr line, for a reason a person can act on. Never carries the header. */
function lastLine(s: string): string {
  return s.split('\n').map(l => l.trim()).filter(Boolean).pop()?.slice(0, 300) ?? '';
}

function git(cwd: string, env: NodeJS.ProcessEnv, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new GitError(`git ${args[0]} failed`, String(stderr)));
      else resolve(String(stdout));
    });
  });
}

/**
 * The environment every git call runs in: no system or global config, no
 * prompts, and the token as an http.extraHeader passed through GIT_CONFIG_*
 * so it is on no command line.
 */
function gitEnv(home: string, token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/** Check the bundle and push it. Every outcome is returned, never thrown. */
export async function publishBundle(cfg: PublishConfig, input: PublishInput): Promise<PublishOutcome> {
  const dir = await mkdtemp(join(tmpdir(), 'termag-ask-'));
  try {
    return await publishIn(dir, cfg, input);
  } catch (err) {
    if (err instanceof GitError) return { kind: 'failed', reason: `${err.message}: ${lastLine(err.stderr) || 'no output'}` };
    return { kind: 'failed', reason: (err as Error).message };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function publishIn(dir: string, cfg: PublishConfig, input: PublishInput): Promise<PublishOutcome> {
  const env = gitEnv(dir, input.token);
  const repoDir = join(dir, 'repo.git');
  const bundlePath = join(dir, 'run.bundle');
  const url = `${cfg.gitBaseUrl}/${input.repo}.git`;
  await writeFile(bundlePath, input.bundle, { mode: 0o600 });
  await git(dir, env, ['init', '-q', '--bare', repoDir]);

  const lines = (await git(repoDir, env, ['bundle', 'list-heads', bundlePath]))
    .split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { kind: 'refused', reason: 'the bundle carries no branch' };
  if (lines.length > MAX_ASK_PRS) return { kind: 'refused', reason: `the bundle carries ${lines.length} branches, more than the ${MAX_ASK_PRS} PRs a thread opens` };
  const heads: Array<{ tip: string; ref: string; key: string }> = [];
  for (const line of lines) {
    const [tip, ref] = line.split(/\s+/);
    if (!/^[0-9a-f]{40}$/.test(tip ?? '') || !(ref === 'HEAD' || ref?.startsWith('refs/'))) return { kind: 'refused', reason: 'the bundle head is malformed' };
    const key = askPrKeyOfRef(ref);
    if (key === null) return { kind: 'refused', reason: `the bundle carries ${ref.slice(0, 100)}, which is neither the run's branch nor a pr/<name> one` };
    if (heads.some(h => h.key === key)) return { kind: 'refused', reason: `the bundle carries the ${key ? `pr/${key}` : "run's own"} branch twice` };
    heads.push({ tip, ref, key });
  }
  heads.sort((a, b) => (a.key === '' ? -1 : b.key === '' ? 1 : a.key.localeCompare(b.key)));

  try {
    await git(repoDir, env, ['fetch', '-q', '--depth=1', '--no-tags', url, input.baseSha]);
  } catch (err) {
    const why = err instanceof GitError ? lastLine(err.stderr) : (err as Error).message;
    return { kind: 'failed', reason: `could not fetch the base commit ${input.baseSha.slice(0, 12)} from ${input.repo} on GitHub: ${why}` };
  }
  try {
    await git(repoDir, env, ['bundle', 'verify', '-q', bundlePath]);
  } catch (err) {
    return { kind: 'refused', reason: `the bundle does not apply on the base commit: ${lastLine((err as GitError).stderr ?? '')}` };
  }
  await git(repoDir, env, ['fetch', '-q', '--no-tags', bundlePath, ...heads.map((h, i) => `${h.ref}:refs/termag/tip${i}`)]);
  const total = Number((await git(repoDir, env, ['rev-list', '--count', ...heads.map(h => h.tip), `^${input.baseSha}`])).trim());
  if (total > MAX_COMMITS) return { kind: 'refused', reason: `${total} commits is more than ${MAX_COMMITS}` };

  let room = MAX_ASK_PRS - Object.keys(input.prNumbers).length;
  const prs: PrOutcome[] = [];
  for (const h of heads) {
    const branch = input.branchFor(h.key);
    const isNew = !(h.key in input.prNumbers);
    if (isNew && room <= 0) {
      prs.push({ kind: 'refused', key: h.key, branch, reason: `the thread already has ${MAX_ASK_PRS} PRs, the most one thread opens` });
      continue;
    }
    let out: PrOutcome;
    try {
      out = await publishHead(cfg, input, repoDir, env, url, h, branch);
    } catch (err) {
      const reason = err instanceof GitError ? `${err.message}: ${lastLine(err.stderr) || 'no output'}` : (err as Error).message;
      out = { kind: 'failed', key: h.key, branch, reason };
    }
    if (isNew && out.kind === 'published') room--;
    prs.push(out);
  }
  return { kind: 'done', prs };
}

/** One branch of the bundle: its own checks, the push, and its draft PR. */
async function publishHead(
  cfg: PublishConfig, input: PublishInput, repoDir: string, env: NodeJS.ProcessEnv, url: string,
  h: { tip: string; key: string }, branch: string,
): Promise<PrOutcome> {
  const { tip, key } = h;
  const refuse = (reason: string): PrOutcome => ({ kind: 'refused', key, branch, reason });
  try {
    await git(repoDir, env, ['merge-base', '--is-ancestor', input.baseSha, tip]);
  } catch {
    return refuse('the commits do not build on the thread\'s base commit');
  }
  const range = `${input.baseSha}..${tip}`;
  const commits = Number((await git(repoDir, env, ['rev-list', '--count', range])).trim());
  if (!commits) return refuse('the branch holds no new commits');
  // `git log -p` shows a merge commit's own changes to neither parent, so the
  // secret scan below could not see them.
  const merges = Number((await git(repoDir, env, ['rev-list', '--count', '--min-parents=2', range])).trim());
  if (merges) return refuse(`the commits include ${merges === 1 ? 'a merge commit' : `${merges} merge commits`}; rebase them onto the base instead`);

  // Raw names, NUL-separated: a line-based listing C-quotes any path with a
  // non-ASCII or control byte, which would not match the protected prefixes.
  const touchedPaths = (await git(repoDir, env, ['log', '-z', '--name-only', '--no-renames', '--format=', range]))
    .split('\0').filter(Boolean);
  const paths = [...new Set(touchedPaths)];
  const hits = [...new Set(paths.map(protectedArea).filter((a): a is string => a !== null))];
  if (hits.length) return refuse(`the commits change protected paths (${hits.join(', ')})`);

  const email = input.askerEmail.toLowerCase();
  const idents = (await git(repoDir, env, ['log', '--format=%ae%x09%ce', range])).split('\n').filter(Boolean);
  const strangers = idents.flatMap(l => l.split('\t')).filter(e => e.toLowerCase() !== email);
  if (strangers.length) return refuse(`every commit must be authored and committed as ${input.askerEmail}; found ${[...new Set(strangers)].join(', ')}`);

  // Every commit is pushed, not just the tip's tree: scan each commit's own
  // patch (binary blobs as text), the commit object as stored (author and
  // committer names, any extra header, the message) and every path it touches
  // (an empty new file has no `+++` line), so a secret added and later
  // removed, put in a message or a name, or used as a file name is refused too.
  const patches = await git(repoDir, env, ['log', '-p', '--text', '-U0', '--no-renames', '--format=', range]);
  const objects = await git(repoDir, env, ['log', '--pretty=raw', '--no-mailmap', range]);
  const touched = touchedPaths.join('\n');
  const secrets = [...new Set([...findSecrets(patches), ...findSecretsInText(objects), ...findSecretsInText(touched)])];
  if (secrets.length) return refuse(`the commits add what looks like a secret (${secrets.join(', ')})`);

  try {
    await git(repoDir, env, ['push', '-q', url, `${tip}:refs/heads/${branch}`]);
  } catch (err) {
    const stderr = (err as GitError).stderr ?? '';
    const why = lastLine(stderr.split('\n').filter(l => !/^\s*hint:/.test(l)).join('\n'));
    if (/non-fast-forward|fetch first|\[rejected\]/i.test(stderr)) {
      return refuse(`${branch} moved on GitHub since the last turn; not overwriting it (${why})`);
    }
    return { kind: 'failed', key, branch, reason: `push to ${input.repo} failed: ${why}` };
  }

  const notes: string[] = [];
  const written = input.prDescriptions[key];
  let run = written?.trim() ? splitDescription(written) : null;
  if (run) {
    const found = findSecretsInText(`${run.title ?? ''}\n${run.body}`);
    if (found.length) {
      notes.push(`the run's PR description was dropped: it looks like it holds a secret (${found.join(', ')})`);
      run = null;
    }
  }
  // Commit messages were scanned above, with everything else in the commits.
  const log = await git(repoDir, env, ['log', '--reverse', '--format=%s%x1f%b%x1e', range]);
  const messages = log.split('\x1e').map(r => r.replace(/^\n/, '')).filter(Boolean)
    .map(r => { const [subject, body = ''] = r.split('\x1f'); return { subject, body }; });
  const description = capDescription(run?.body || commitDescription(messages));

  let title = run?.title || '';
  if (!title) {
    const subject = (messages[0]?.subject ?? '').trim().slice(0, 120);
    title = `${subject || 'termag ask'}${commits > 1 ? ` (+${commits - 1} more)` : ''}`;
  }
  const pr = await ensureDraftPr(cfg, { repo: input.repo, token: input.token, branch, prNumber: input.prNumbers[key] ?? null }, title, input.prBody(description, key));
  if ('error' in pr) return { kind: 'failed', key, branch, reason: `pushed ${branch}, but the draft PR could not be opened: ${pr.error}` };
  if (pr.note) notes.push(pr.note);
  return {
    kind: 'published', key, branch, headSha: tip, commits, prNumber: pr.number, prUrl: pr.url, prCreated: pr.created,
    ...(notes.length ? { note: notes.join('; ') } : {}),
  };
}

type PrFound = { number: number; url: string; created: boolean; note?: string };

/** Open a branch's draft PR, or find it and bring its body up to date; the title is set only on opening. */
async function ensureDraftPr(
  cfg: PublishConfig, input: { repo: string; token: string; branch: string; prNumber: number | null }, title: string, body: string,
): Promise<PrFound | { error: string }> {
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'termag-ask',
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await cfg.fetch(`${cfg.apiBaseUrl}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    return { status: res.status, data };
  };
  // A failed update leaves the PR as it was; the push and the PR still count.
  const existing = async (p: Record<string, unknown>): Promise<PrFound> => {
    const found: PrFound = { number: Number(p.number), url: String(p.html_url ?? ''), created: false };
    const current = typeof p.body === 'string' ? p.body : '';
    const next = replaceMarkedBody(current, body);
    if (next === null) return { ...found, note: "the PR's body no longer has termag's markers, so its description was left alone" };
    if (next === current) return found;
    const r = await api('PATCH', `/repos/${input.repo}/pulls/${found.number}`, { body: next });
    return r.status === 200 ? found : { ...found, note: `the PR's description could not be updated (PATCH answered ${r.status})` };
  };
  const [owner] = input.repo.split('/');
  try {
    if (input.prNumber) {
      const r = await api('GET', `/repos/${input.repo}/pulls/${input.prNumber}`);
      if (r.status === 200 && r.data?.state === 'open') return await existing({ ...r.data, number: input.prNumber });
    }
    const open = await api('GET', `/repos/${input.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.branch}`)}`);
    if (open.status === 200 && Array.isArray(open.data) && open.data.length) {
      return await existing(open.data[0] as Record<string, unknown>);
    }
    const repo = await api('GET', `/repos/${input.repo}`);
    const base = repo.status === 200 && typeof repo.data?.default_branch === 'string' ? repo.data.default_branch : null;
    if (!base) return { error: `GET /repos/${input.repo} answered ${repo.status}` };
    const created = await api('POST', `/repos/${input.repo}/pulls`, {
      title, head: input.branch, base, body, draft: true,
    });
    if (created.status !== 201 || !created.data) {
      const msg = typeof created.data?.message === 'string' ? created.data.message : '';
      return { error: `POST /pulls answered ${created.status}${msg ? `: ${msg}` : ''}` };
    }
    return { number: Number(created.data.number), url: String(created.data.html_url ?? ''), created: true };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
