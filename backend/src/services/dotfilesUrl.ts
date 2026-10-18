export type DotfilesUrlResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * Validate and canonicalise the one repository form the claim runner accepts.
 *
 * Keeping this deliberately narrower than git itself prevents the orchestrator
 * from turning a user preference into an arbitrary-host fetch. Empty input and
 * null both clear the preference.
 */
export function parseDotfilesRepoUrl(input: unknown): DotfilesUrlResult {
  if (input === null || input === undefined || input === '') {
    return { ok: true, value: null };
  }
  if (typeof input !== 'string') {
    return { ok: false, error: 'dotfilesRepoUrl must be a GitHub HTTPS URL or null' };
  }

  const trimmed = input.trim();
  if (trimmed === '') return { ok: true, value: null };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'dotfilesRepoUrl must be a valid URL' };
  }

  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    return { ok: false, error: 'dotfilesRepoUrl must use https://github.com' };
  }
  if (url.username || url.password || url.port || url.search || url.hash) {
    return { ok: false, error: 'dotfilesRepoUrl must name only a GitHub repository' };
  }

  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2) {
    return { ok: false, error: 'dotfilesRepoUrl must have the form https://github.com/owner/repo' };
  }
  const [owner, rawRepo] = parts;
  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo;
  const segment = /^[A-Za-z0-9_.-]+$/;
  if (!owner || !repo || !segment.test(owner) || !segment.test(repo)) {
    return { ok: false, error: 'dotfilesRepoUrl contains an invalid owner or repository name' };
  }

  return { ok: true, value: `https://github.com/${owner}/${repo}` };
}
