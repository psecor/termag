import { describe, it, expect } from 'vitest';
import {
  chooseGuess, classifyReviewPane, isDevinForeground, parseGhPrView, parsePrInput, prFromLaunchEcho, prFromText, prNumberFromUrl,
  reviewLaunchCommand, urlForPr, buildReviewPrompt, reviewPromptHeader, renderReviewTemplate, parseReviewBody, reviewPromptPath,
  DEFAULT_REVIEW_TEMPLATE, MAX_REVIEW_BODY, reviewAttribution, reviewPromptFooter, reviewTemplateCandidates, chooseReviewTemplate,
} from './review';

describe('parsePrInput', () => {
  it('accepts a number, #number, "PR 123" and a GitHub PR URL', () => {
    expect(parsePrInput('123')).toBe(123);
    expect(parsePrInput(' #123 ')).toBe(123);
    expect(parsePrInput('PR 123')).toBe(123);
    expect(parsePrInput('pr#7')).toBe(7);
    expect(parsePrInput('https://github.com/example-org/termag/pull/185')).toBe(185);
  });
  it('rejects anything else', () => {
    expect(parsePrInput('')).toBeNull();
    expect(parsePrInput('0')).toBeNull();
    expect(parsePrInput('abc')).toBeNull();
    expect(parsePrInput('123; rm -rf /')).toBeNull();
    expect(parsePrInput('https://github.com/example-org/termag/issues/185')).toBeNull();
    expect(parsePrInput('123456789')).toBeNull();
  });
});

describe('parseGhPrView', () => {
  it('reads the fields gh prints and validates the url', () => {
    const out = JSON.stringify({ number: 185, url: 'https://github.com/example-org/termag/pull/185', title: 'dark features', state: 'OPEN', headRefName: 'termag-dark-features' });
    expect(parseGhPrView(out)).toEqual({ number: 185, url: 'https://github.com/example-org/termag/pull/185', title: 'dark features', state: 'OPEN', headRefName: 'termag-dark-features' });
    expect(parseGhPrView(JSON.stringify({ number: 1, url: 'javascript:alert(1)' }))!.url).toBeNull();
  });
  it('returns null for not-json, no PR, or a bad number', () => {
    expect(parseGhPrView('no pull requests found for branch "x"')).toBeNull();
    expect(parseGhPrView('{}')).toBeNull();
    expect(parseGhPrView(JSON.stringify({ number: '12' }))).toBeNull();
    expect(parseGhPrView('null')).toBeNull();
  });
});

describe('prFromText', () => {
  it('prefers the LAST PR url in the capture', () => {
    const text = [
      'Opened https://github.com/o/r/pull/10',
      '...',
      '⏺ Bash(gh pr create ...)',
      '  https://github.com/o/r/pull/12',
      '> ',
    ].join('\n');
    expect(prFromText(text)).toEqual({ number: 12, url: 'https://github.com/o/r/pull/12' });
  });
  it('falls back to the last "PR #n" phrase and ignores bare #n', () => {
    expect(prFromText('fixes #4\nworking on PR #44 now\nsee pull request 45')).toEqual({ number: 45, url: null });
    expect(prFromText('fixes #4 and #5')).toBeNull();
    expect(prFromText('')).toBeNull();
  });
});

describe('chooseGuess', () => {
  const gh = { number: 1, url: 'https://github.com/o/r/pull/1', title: 't', state: 'OPEN', headRefName: 'feat' };
  it('ranks an open gh PR > milestone > pane', () => {
    expect(chooseGuess({ gh, branch: 'feat', milestoneUrl: 'https://github.com/o/r/pull/2', pane: { number: 3, url: null } })?.number).toBe(1);
    expect(chooseGuess({ gh: null, branch: 'feat', milestoneUrl: 'https://github.com/o/r/pull/2', pane: { number: 3, url: null } }))
      .toEqual({ number: 2, url: 'https://github.com/o/r/pull/2', title: null, branch: null, state: null, source: 'milestone' });
    expect(chooseGuess({ gh: null, branch: null, milestoneUrl: null, pane: { number: 3, url: null } })?.source).toBe('pane');
    expect(chooseGuess({ gh: null, branch: null, milestoneUrl: null, pane: null })).toBeNull();
  });
  it('a merged or closed gh PR only wins when nothing else is there', () => {
    const merged = { ...gh, state: 'MERGED' };
    expect(chooseGuess({ gh: merged, branch: 'feat', milestoneUrl: null, pane: { number: 3, url: null } })?.number).toBe(3);
    expect(chooseGuess({ gh: merged, branch: 'feat', milestoneUrl: null, pane: null })).toEqual({ number: 1, url: gh.url, title: 't', branch: 'feat', state: 'MERGED', source: 'gh' });
  });
  it('carries the branch, title and state from gh', () => {
    expect(chooseGuess({ gh, branch: 'other', milestoneUrl: null, pane: null })).toEqual({ number: 1, url: gh.url, title: 't', branch: 'feat', state: 'OPEN', source: 'gh' });
  });
  it('urlForPr only accepts a GitHub PR url for that number', () => {
    expect(urlForPr('https://github.com/o/r/pull/9', 9)).toBe('https://github.com/o/r/pull/9');
    expect(urlForPr('https://github.com/o/r/pull/9', 8)).toBeNull();
    expect(urlForPr('https://github.com/o/r/issues/9', 9)).toBeNull();
    expect(urlForPr(null, 9)).toBeNull();
  });
});

describe('reviewLaunchCommand', () => {
  it('points devin at the prompt file through $HOME; the prompt never reaches the shell', () => {
    expect(reviewLaunchCommand('ada-web-review'))
      .toBe('devin --permission-mode smart --prompt-file "$HOME/.termag/review-prompts/ada-web-review.md"');
  });
  it('refuses a session name that is not plain', () => {
    expect(() => reviewLaunchCommand("a'b")).toThrow();
    expect(() => reviewLaunchCommand('a$(x)')).toThrow();
    expect(() => reviewLaunchCommand('../x')).toThrow();
    expect(() => reviewLaunchCommand('..')).toThrow();
    expect(() => reviewLaunchCommand('a/b')).toThrow();
  });
  it('reviewPromptPath (the write-file path) and the launch line name the same file under the home', () => {
    expect(reviewPromptPath('/home/first.last/', 'first_last-web-review'))
      .toBe('/home/first.last/.termag/review-prompts/first_last-web-review.md');
    // An agent with path_remap /home/first.last → /Users/first.last writes it
    // there, and that pane's $HOME is /Users/first.last: the typed line follows.
    expect(reviewLaunchCommand('first_last-web-review')).toContain('"$HOME/.termag/review-prompts/first_last-web-review.md"');
    expect(() => reviewPromptPath('/home/a', 'a/../b')).toThrow();
  });
});

describe('buildReviewPrompt', () => {
  const url = 'https://github.com/example-org/termag/pull/185';
  it('is the fixed header, the rendered built-in body and the attribution footer by default', () => {
    const p = buildReviewPrompt(185, url, null);
    const lines = p.trimEnd().split('\n');
    const header = lines[0];
    expect(header).toBe(`${reviewPromptHeader(185, url)}`);
    expect(header).toContain('#185 (https://github.com/example-org/termag/pull/185)');
    expect(header).toContain('in the repository example-org/termag. Pass --repo example-org/termag to every gh command');
    expect(header).not.toContain('current directory for');
    expect(prFromLaunchEcho(header)).toEqual({ number: 185, url });
    expect(lines.slice(1, -1).join('\n')).toBe(renderReviewTemplate(DEFAULT_REVIEW_TEMPLATE, 185, url));
    expect(lines[lines.length - 1]).toBe(reviewPromptFooter());
    expect(p).toContain('gh pr diff 185');
    expect(p).not.toContain('{{');
  });
  it('keeps an edited body verbatim apart from the placeholders, quotes and newlines included', () => {
    const p = buildReviewPrompt(7, null, "Check {{pr}}'s migration.\nSee {{ url }}.");
    expect(p).toBe(`Review GitHub pull request #7 for the repository in the current directory.\nCheck 7's migration.\nSee #7.\n${reviewPromptFooter()}\n`);
  });
  it('drops a url that is not this PR', () => {
    expect(buildReviewPrompt(5, 'https://github.com/o/r/pull/6', '{{url}}')).toBe(
      `Review GitHub pull request #5 for the repository in the current directory.\n#5\n${reviewPromptFooter()}\n`);
  });
  it('the footer asks for the reviewer\'s attribution line on anything posted, whatever the body says', () => {
    expect(reviewAttribution()).toBe('Reviewed by Devin');
    expect(reviewPromptFooter()).toContain('"Reviewed by Devin"');
    expect(reviewPromptFooter('Claude')).toContain('"Reviewed by Claude"');
    expect(buildReviewPrompt(9, null, 'Post the review with gh pr review when done.')).toContain(reviewPromptFooter());
  });
  it('the header round-trips through prFromLaunchEcho', () => {
    expect(prFromLaunchEcho(`❭ ${buildReviewPrompt(205, 'https://github.com/o/r/pull/205', 'anything')}`))
      .toEqual({ number: 205, url: 'https://github.com/o/r/pull/205' });
  });
});

describe('parseReviewBody', () => {
  it('absent means the built-in template', () => {
    expect(parseReviewBody(undefined)).toEqual({ ok: true, body: null });
    expect(parseReviewBody(null)).toEqual({ ok: true, body: null });
  });
  it('normalizes line endings and trims', () => {
    expect(parseReviewBody('  a\r\nb\rc\t \n')).toEqual({ ok: true, body: 'a\nb\nc' });
  });
  it('refuses empty, oversized, non-string and control characters', () => {
    expect(parseReviewBody('   ').ok).toBe(false);
    expect(parseReviewBody('x'.repeat(MAX_REVIEW_BODY + 1)).ok).toBe(false);
    expect(parseReviewBody(42).ok).toBe(false);
    expect(parseReviewBody('a\u0000b').ok).toBe(false);
    expect(parseReviewBody('a\u001b[31mb').ok).toBe(false);
  });
});

describe('helpers', () => {
  it('prNumberFromUrl / isDevinForeground', () => {
    expect(prNumberFromUrl('https://github.com/o/r/pull/9')).toBe(9);
    expect(prNumberFromUrl('https://github.com/o/r/issues/9')).toBeNull();
    expect(prNumberFromUrl(null)).toBeNull();
    expect(isDevinForeground('devin')).toBe(true);
    expect(isDevinForeground('zsh')).toBe(false);
    expect(isDevinForeground(null)).toBe(false);
  });
});

describe('classifyReviewPane', () => {
  // Captures from a real `devin` 3000.11 review pane on 2026-10-06.
  const waiting = [
    ' I\'ll review PR #205. Let me fetch it first.',
    ' ● Running command',
    ' └ $ gh pr view 205',
    '❭ 1 Yes  (Approve once)',
    '  2 Yes, allow `gh pr` commands',
    '  8 No',
    '↑↓ select · ↵ confirm · esc cancel',
  ].join('\n');
  const working = [
    ' │ +  role: \'agent\' | \'ctrl\' | \'data\' | \'data-ctrl\' | \'review\',',
    ' └ Exited with code 0',
    '⠀⠴ Thinking · 39s (esc twice to interrupt)',
    '────────────────────────────────────────',
    '❭ Guide Devin while it works',
    '────────────────────────────────────────',
    'SWE-2 High                      Context: 16k / 262k tokens (6%)',
  ].join('\n');
  const done = [
    ' Verdict: approve with nits.',
    '────────────────────────────────────────',
    '❭ ',
    '────────────────────────────────────────',
    'SWE-2 High                      Context: 40k / 262k tokens (15%)',
  ].join('\n');
  it('tells an approval prompt, activity, the finished prompt and an exited devin apart', () => {
    expect(classifyReviewPane('devin', waiting)).toBe('waiting');
    expect(classifyReviewPane('devin', working)).toBe('reviewing');
    expect(classifyReviewPane('devin', done)).toBe('done');
    expect(classifyReviewPane('zsh', done)).toBe('exited');
    expect(classifyReviewPane(null, '')).toBe('exited');
  });
  it('waiting beats activity when both show', () => {
    expect(classifyReviewPane('devin', `${working}\n${waiting}`)).toBe('waiting');
  });
  it('ignores pattern text Devin merely printed above its chrome', () => {
    // Seen live: Devin reviewing this very PR echoed the diff, including the
    // regex sources, and the bar flipped to "needs an answer".
    const echoed = [
      " │ +const DEVIN_WAITING = [/↑↓\\s+select\\s*·\\s*↵\\s+confirm/, /esc cancel/];",
      " │ +  /esc twice to interrupt/,",
      " └ Exited with code 0",
      '⠀⠚ Thinking · 4m 7s (esc twice to interrupt) · (3431c)',
      '────────────────────────────────────────',
      '❭ Guide Devin while it works',
      '────────────────────────────────────────',
      'SWE-2 High                      ctrl+o details · alt+t thinking',
    ].join('\n');
    expect(classifyReviewPane('devin', echoed)).toBe('reviewing');
    const quotedWhenDone = [
      ' The footer reads "↑↓ select · ↵ confirm" when Devin asks.',
      ' Verdict: approve.',
      '────────────────────────────────────────',
      '❭ ',
      '────────────────────────────────────────',
      'SWE-2 High                      Context: 40k / 262k tokens (15%)',
    ].join('\n');
    expect(classifyReviewPane('devin', quotedWhenDone)).toBe('done');
  });
});

describe('prFromLaunchEcho', () => {
  it('reads the PR back from the echoed launch line, url only when it matches the number', () => {
    const pane = `$ ${reviewLaunchCommand('a-p-review')}\n❭ Review GitHub pull request #205 (https://github.com/example-org/termag/pull/205) for\n  the repository`;
    expect(prFromLaunchEcho(pane)).toEqual({ number: 205, url: 'https://github.com/example-org/termag/pull/205' });
    expect(prFromLaunchEcho(reviewPromptHeader(7, null))).toEqual({ number: 7, url: null });
    expect(prFromLaunchEcho('Review GitHub pull request #7 (https://github.com/o/r/pull/8)')).toEqual({ number: 7, url: null });
    // The shell echo wrapped mid-URL; Devin's re-print below it is whole.
    const wrapped = "$ devin --permission-mode smart -- 'Review GitHub pull request #205 (https://github.com/example-org/termag/pu\nll/205) for the repository'\n❭ Review GitHub pull request #205 (https://github.com/example-org/termag/pull/205) for";
    expect(prFromLaunchEcho(wrapped)).toEqual({ number: 205, url: 'https://github.com/example-org/termag/pull/205' });
    expect(prFromLaunchEcho('nothing here')).toBeNull();
  });
});

describe('review prompt templates', () => {
  const cands = reviewTemplateCandidates('/home/ada/termag/projects/web/.worktrees/fix/', '/home/ada/');
  it('looks in the repo, then the XDG home path, then the top-level dotfile', () => {
    expect(cands.map(c => [c.source, c.path])).toEqual([
      ['repo', '/home/ada/termag/projects/web/.worktrees/fix/.termag/review-prompt.md'],
      ['home', '/home/ada/.config/termag/review-prompt.md'],
      ['home', '/home/ada/.termag-review-prompt.md'],
    ]);
  });
  it('the first usable file wins', () => {
    expect(chooseReviewTemplate(cands, ['repo rules {{pr}}', 'mine', 'dot'])).toEqual(
      { template: 'repo rules {{pr}}', source: 'repo', label: cands[0].label, warnings: [] });
    expect(chooseReviewTemplate(cands, [null, null, ' dot\r\n'])).toMatchObject({ template: 'dot', source: 'home', label: '~/.termag-review-prompt.md' });
  });
  it('falls back to the built-in template', () => {
    expect(chooseReviewTemplate(cands, [null, null, null])).toEqual(
      { template: DEFAULT_REVIEW_TEMPLATE, source: 'builtin', label: null, warnings: [] });
  });
  it('skips an empty or invalid file with a warning', () => {
    const r = chooseReviewTemplate(cands, ['  \n', 'x'.repeat(MAX_REVIEW_BODY + 1), 'ok']);
    expect(r).toMatchObject({ template: 'ok', source: 'home' });
    expect(r.warnings).toEqual([
      '.termag/review-prompt.md in the repo: The prompt is empty',
      `~/.config/termag/review-prompt.md: The prompt is longer than ${MAX_REVIEW_BODY} characters`,
    ]);
  });
  it('a chosen template still gets the fixed header and footer', () => {
    const t = chooseReviewTemplate(cands, ['Check the migration in {{pr}}.', null, null]).template;
    expect(buildReviewPrompt(3, null, t)).toBe(
      `Review GitHub pull request #3 for the repository in the current directory.\nCheck the migration in 3.\n${reviewPromptFooter()}\n`);
  });
});
