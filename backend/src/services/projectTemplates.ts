// Project templates for the first-run wizard (and anyone else who wants a
// project that starts as a clone): a short list of known repos plus "custom".
//
// A template turns into a `repoUrl` on POST /api/projects. A box whose agent
// runs durable clones clones it itself (services/projectClone.ts). Otherwise
// the clone runs IN the project's agent pane, ahead of the agent launch
// command, so the owner watches progress (a large clone can take minutes) and
// any auth prompt lands where they can answer it. Nothing new on the box: the
// pane already has git, and GitHub auth comes from the owner's connected
// credentials (the box's git credential helper / broker.md).
//
// Why fetch-into-the-initialised-repo rather than `git clone`: tmux-create
// `git init`s the project dir (and the wiki seeding puts AGENTS.md/CLAUDE.md
// there), so the dir is never empty; `git clone .` would refuse. We skip the
// wiki seed for repo projects (the repo brings its own) and fetch into the
// fresh .git instead.
//
// Pure: validated and unit-tested without a server.

export interface ProjectTemplate {
  id: string;
  label: string;
  repoUrl: string;
  /** Baked clone on the box image whose objects a fetch can borrow (git alternates). */
  referenceDir?: string;
  blurb: string;
}

export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: 'termag',
    label: 'termag',
    repoUrl: 'https://github.com/psecor/termag.git',
    referenceDir: '$HOME/src/termag',
    blurb: 'termag itself: hack on the tool you are using. Box images carry a baked clone, so this is fast.',
  },
] as const;

// GitHub only, the two forms git accepts. Keeps a typed URL from becoming a
// shell argument we didn't expect (it is single-quoted below regardless).
const HTTPS_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const SSH_RE = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;

export function parseRepoUrl(input: unknown): { ok: true; url: string; owner: string; repo: string } | { ok: false; error: string } {
  if (typeof input !== 'string') return { ok: false, error: 'repoUrl must be a string' };
  const s = input.trim();
  const m = HTTPS_RE.exec(s) ?? SSH_RE.exec(s);
  if (!m) return { ok: false, error: 'repoUrl must be a GitHub repository URL (https://github.com/owner/repo or git@github.com:owner/repo.git)' };
  const [, owner, repo] = m;
  return { ok: true, url: s, owner, repo };
}

/** Project name suggestion for a repo: its basename, made tmux/filesystem safe. */
export function suggestProjectName(repoUrl: string): string {
  const p = parseRepoUrl(repoUrl);
  const base = p.ok ? p.repo : 'project';
  return base.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
// Double quotes for the reference dir: it is a server-side constant that
// deliberately contains `$HOME`, which the PANE's shell must expand (the box
// owner's home is not known here). Only the characters that are special inside
// double quotes other than `$` are escaped.
const dq = (s: string) => `"${s.replace(/(["\\`])/g, '\\$1')}"`;

/**
 * The shell that turns the freshly `git init`ed project dir into a checkout of
 * `repoUrl`'s default branch. Typed into the agent pane ahead of the agent's
 * own launch command. With `referenceDir` (a baked clone on the box), the
 * fetch borrows that clone's objects via git alternates, so only the delta
 * comes over the network.
 *
 * `blankGlobalGitconfig` is only for a managed box. The broker rewrite lives
 * in the system gitconfig; a longer `insteadOf` in the user's `~/.gitconfig`
 * (the baked ssh rewrite, or one dotfiles installed) would otherwise win and
 * send the fetch somewhere with no key. The prefix is one assignment per git
 * command, not `export` and not a subshell: it does not reach the agent
 * started after `&&`, and the process-group leader stays git so a reconnect
 * sees the live fetch. A host or external box has no broker rules in system
 * gitconfig, so the same prefix would drop that machine's credential helper
 * and `insteadOf`. Those creates leave the global gitconfig alone.
 */
export function buildCloneCommand(
  repoUrl: string,
  referenceDir?: string,
  opts?: { blankGlobalGitconfig?: boolean },
): string {
  // One-command prefix, not `export`: the process-group leader stays git.
  const git = (args: string) => opts?.blankGlobalGitconfig ? `GIT_CONFIG_GLOBAL=/dev/null git ${args}` : `git ${args}`;
  const parts: string[] = [];
  if (referenceDir) {
    // Only when the baked clone exists; harmless otherwise. Alternates must
    // point at the objects dir and the file lives under .git/objects/info.
    const objects = dq(`${referenceDir}/.git/objects`);
    parts.push(`{ [ -d ${objects} ] && mkdir -p .git/objects/info && echo ${objects} >> .git/objects/info/alternates; true; }`);
  }
  // Tolerant of a retry in a dir that already has the remote.
  parts.push(`{ ${git(`remote add origin ${sq(repoUrl)}`)} 2>/dev/null || ${git(`remote set-url origin ${sq(repoUrl)}`)}; }`);
  parts.push(git('fetch --progress origin'));
  parts.push(git('remote set-head origin -a'));
  // Check out the remote's default branch under its own name, tracking origin.
  parts.push(`${git('checkout --track')} "$(${git('symbolic-ref --short refs/remotes/origin/HEAD')})"`);
  parts.push(`mkdir -p .git/info && { grep -qxF '/.worktrees/' .git/info/exclude 2>/dev/null || echo '/.worktrees/' >> .git/info/exclude; }`);
  return parts.join(' && ');
}

/** Canonical owner/repo key for comparing the https and ssh spellings of one repo. */
export function repoKey(url: string): string | null {
  const p = parseRepoUrl(url);
  return p.ok ? `${p.owner}/${p.repo}`.toLowerCase() : null;
}

/** The known template a user-supplied URL refers to, if any (so its baked clone can be used). */
export function templateForRepoUrl(url: string): ProjectTemplate | null {
  const key = repoKey(url);
  if (!key) return null;
  return PROJECT_TEMPLATES.find(t => repoKey(t.repoUrl) === key) ?? null;
}

export function templateById(id: unknown): ProjectTemplate | null {
  if (typeof id !== 'string') return null;
  return PROJECT_TEMPLATES.find(t => t.id === id) ?? null;
}

/**
 * The CLI's `--from`, which takes what the web form's "Start from" picker
 * offers: a template id or a GitHub URL. Resolves to the `repoUrl` the
 * project create handler takes.
 */
export function resolveStartFrom(from: string): { ok: true; repoUrl: string } | { ok: false; error: string } {
  const template = templateById(from);
  if (template) return { ok: true, repoUrl: template.repoUrl };
  const parsed = parseRepoUrl(from);
  if (parsed.ok) return { ok: true, repoUrl: parsed.url };
  const ids = PROJECT_TEMPLATES.map(t => t.id).join(', ');
  return { ok: false, error: `from must be a template (${ids}) or a GitHub repository URL` };
}
