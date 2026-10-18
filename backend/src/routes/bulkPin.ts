// Pure request-body validation for the bulk pin/unpin endpoint. Kept in its own
// module (rather than inline in projects.ts) so it can be unit-tested without
// pulling in projects.ts's side effects — the module-level PrismaClient and the
// tmux/slack/agentRegistry imports. Mirrors auth/allowedUsers.ts.

export interface BulkPinInput {
  projectIds: string[];
  pinned: boolean;
}

// Returns the parsed input, or `{ error }` describing why the body was rejected.
// Project ids are de-duplicated so a caller that sends the same id twice doesn't
// matter to the downstream updateMany.
export function parseBulkPinBody(body: unknown): BulkPinInput | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'body must be an object' };
  }
  const { projectIds, pinned } = body as { projectIds?: unknown; pinned?: unknown };

  if (typeof pinned !== 'boolean') {
    return { error: 'pinned must be a boolean' };
  }
  if (!Array.isArray(projectIds) || projectIds.length === 0) {
    return { error: 'projectIds must be a non-empty array' };
  }
  if (!projectIds.every(id => typeof id === 'string')) {
    return { error: 'projectIds must contain only strings' };
  }

  return { projectIds: [...new Set(projectIds as string[])], pinned };
}
