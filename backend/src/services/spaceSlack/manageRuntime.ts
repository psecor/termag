/**
 * The production wiring of routes/spaceSlack.ts: the link service's
 * (runtime.ts), plus the admin store, termag's own bot user id (left out of
 * the bystander count), and the staging fake workspace when it is switched on
 * (fakeWorkspace.ts).
 */
import { fakeWorkspace, fakeWorkspaceEnabled } from './fakeWorkspace';
import type { LinkSlackClient } from './link';
import { prismaSpaceSlackAdminStore, type ManageDeps } from './manage';
import type { PickerSlackClient } from './picker';
import { spaceSlackLinkDeps } from './runtime';
import { prismaSpaceStore } from '../spaces/spaceStorePrisma';

type Client = LinkSlackClient & PickerSlackClient & { auth?: { test(): Promise<{ user_id?: string }> } };

let botUserId: Promise<string | undefined> | null = null;

function botUserIdOf(client: Client): Promise<string | undefined> {
  botUserId ??= (client.auth?.test() ?? Promise.resolve({ user_id: undefined }))
    .then(r => r.user_id)
    .catch(err => { botUserId = null; console.error('[SPACE-SLACK] auth.test failed:', (err as Error).message); return undefined; });
  return botUserId;
}

export function spaceSlackMode(): 'slack' | 'fake' | 'none' {
  if (fakeWorkspaceEnabled()) return 'fake';
  return spaceSlackLinkDeps().slack ? 'slack' : 'none';
}

export async function spaceSlackManageDeps(): Promise<ManageDeps & { slack: Client | null }> {
  const base = spaceSlackLinkDeps();
  const deps = { ...base, spaces: prismaSpaceStore, admin: prismaSpaceSlackAdminStore, slack: base.slack as Client | null };
  if (fakeWorkspaceEnabled()) {
    const ws = fakeWorkspace();
    return { ...deps, slack: ws.client, botUserId: ws.botUserId, store: ws.wrapStore(deps.store) };
  }
  if (deps.slack) deps.botUserId = await botUserIdOf(deps.slack);
  return deps;
}
