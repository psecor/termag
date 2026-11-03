/**
 * Whether a line is Claude's sign-in failing (not a model or network error):
 * what termag web's chat reads as "Sign in to Claude" (frontend/src/chat/claudeLogin.ts
 * isClaudeAuthError). claudeAuthError.mirror.test.ts runs both on the same lines.
 */
// What Claude Code says when its sign-in is gone: "Invalid API key · Please
// run /login", "OAuth token has expired…", an API 401 authentication_error.
const AUTH_ERROR_RE = /please run \/login|oauth token (?:has )?expired|invalid api key|authentication_error|not logged in|failed to authenticate/i;

export function isClaudeAuthError(text: unknown): boolean {
  return typeof text === 'string' && AUTH_ERROR_RE.test(text);
}
