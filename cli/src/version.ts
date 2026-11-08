/**
 * The CLI's version, as `termag --version` prints it and every request's
 * User-Agent, usage report and bug report carries it:
 * `<major>.<minor>.<commits touching cli/>+<the latest one's sha>`, e.g.
 * `0.1.157+c4b6b803` (`.dirty` after it when cli/ has uncommitted changes).
 * buildVersion.mjs works it out from git and build.mjs sets it; a build
 * without the history (a shallow clone, a copy) is package.json's version
 * with `+unknown`. Run from the sources (vitest), it is package.json's.
 */
declare const __TERMAG_CLI_VERSION__: string | undefined;

export const VERSION: string = typeof __TERMAG_CLI_VERSION__ === 'string' ? __TERMAG_CLI_VERSION__ : '0.1.0';
