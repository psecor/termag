/**
 * The secret-shaped strings termag refuses to publish or load: an ask's
 * commits and PR descriptions (askPublish.ts), handoffs, Collab posts,
 * automation reports, bug reports (redacted, not refused), and a space's shared agent memory,
 * which the CLI scans on the box, on write and on load, because space bytes
 * never pass through the orchestrator.
 *
 * The CLI cannot import this file, so cli/src/secretPatterns.ts is a copy;
 * secretPatterns.test.ts fails when the two lists differ. Change both.
 */

export const SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; what: string }> = [
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
    for (const s of SECRET_PATTERNS) if (s.re.test(line)) found.add(s.what);
  }
  return [...found];
}

/** The kinds of secret-shaped strings on any line of a text, such as commit messages. */
export function findSecretsInText(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split('\n')) for (const s of SECRET_PATTERNS) if (s.re.test(line)) found.add(s.what);
  return [...found];
}

/**
 * A PEM private key from its BEGIN line through the matching END line, or to
 * the end of the text when there is none (cut-off output). SECRET_PATTERNS
 * matches only the header, which is enough to refuse a text but would leave
 * the key itself in one that is kept.
 */
const PEM_PRIVATE_KEY_BLOCK = /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g;

/**
 * The text with every secret-shaped string replaced by `[redacted: <what>]`,
 * and the kinds replaced. For text termag keeps rather than refuses, such as a
 * bug report's body and error output.
 */
export function redactSecrets(text: string): { text: string; redacted: string[] } {
  const found = new Set<string>();
  let out = text.replace(PEM_PRIVATE_KEY_BLOCK, () => { found.add('private key'); return '[redacted: private key]'; });
  for (const s of SECRET_PATTERNS) {
    out = out.replace(new RegExp(s.re.source, 'g'), () => { found.add(s.what); return `[redacted: ${s.what}]`; });
  }
  return { text: out, redacted: [...found] };
}
