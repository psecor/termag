/**
 * The desktop's rows (GET /api/cli/v1/chats, status.problem) call a lost
 * Claude sign-in what termag web's chat calls one. When this fails, web's
 * isClaudeAuthError changed: change services/claudeAuthError.ts to match.
 */
import { describe, expect, it } from 'vitest';
import { isClaudeAuthError as web } from '../../../frontend/src/chat/claudeLogin';
import { isClaudeAuthError as server } from './claudeAuthError';

const lines = [
  'Not logged in · Please run /login',
  'Invalid API key · Please run /login',
  'OAuth token has expired. Please obtain a new token or refresh your existing token.',
  'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  'Failed to authenticate. API Error: 403',
  'API Error: 529 Overloaded',
  'Request timed out',
  'I fixed the login page',
  '',
];

describe('isClaudeAuthError mirrors termag web', () => {
  it('reads the same lines as a lost sign-in', () => {
    for (const line of [...lines, null, 42]) expect(server(line), String(line)).toBe(web(line));
    expect(lines.filter(l => server(l))).toHaveLength(5);
  });
});
