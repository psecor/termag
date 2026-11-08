/**
 * A fake Slack workspace for staging and local development
 * (`SPACE_SLACK_FAKE_WORKSPACE=1`, honoured only under `AUTH_MODE=local`, like
 * TERMAG_FLAGS), so the space dialog and `termag space slack`
 * can be tried without a Slack app. The rows and audit events are real; no
 * Slack call is made. Messages termag would post are logged as
 * `[fake Slack] #channel: …`.
 *
 * Every termag user gets a fake Slack id (`UFAKE…`) unless they have a real
 * one, and is a member of the seeded channels marked `everyone` below. The
 * channels are seeded with fixed ids on every start, so links made earlier
 * still point at them; channels created through it get random ids and are
 * gone after a restart (unlinking one still works).
 *
 * | id          | name             | what it shows                                          |
 * |-------------|------------------|--------------------------------------------------------|
 * | C0FAKEGEN1  | general          | public, termag not in yet (joins on link), 12 bystanders |
 * | C0FAKETEAM  | team-payments    | public, termag in, 3 bystanders                        |
 * | G0FAKELEAD  | leads            | private, termag in, you in, 1 bystander                |
 * | G0FAKEHR01  | hr-private       | private, termag in, you not in: hidden from the picker; not_in_channel by id |
 * | G0FAKESEC1  | secret-private   | private, termag not in: hidden; needs_invite by id     |
 * | C0FAKEPROJ  | proj-demo-main   | a workstream channel: disabled                         |
 * | C0FAKEEXT1  | partner-shared   | Slack Connect: disabled                                |
 */
import { randomBytes } from 'node:crypto';
import type { LinkSlackClient } from './link';
import type { SpaceSlackStore } from './linkStore';
import type { PickerSlackClient } from './picker';
import { fakeSlackWorkspace, type FakeChannel } from './spaceSlackTestkit';

export function fakeWorkspaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SPACE_SLACK_FAKE_WORKSPACE === '1' && env.AUTH_MODE === 'local';
}

const bystanders = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `UBY${tag}${String(i).padStart(4, '0')}`);

const SEED = [
  { id: 'C0FAKEGEN1', name: 'general', everyone: true, extra: bystanders(12, 'GEN') },
  { id: 'C0FAKETEAM', name: 'team-payments', is_member: true, everyone: true, extra: bystanders(3, 'TEA') },
  { id: 'G0FAKELEAD', name: 'leads', is_private: true, is_member: true, everyone: true, extra: bystanders(1, 'LEA') },
  { id: 'G0FAKEHR01', name: 'hr-private', is_private: true, is_member: true, everyone: false, extra: bystanders(4, 'HRP') },
  { id: 'G0FAKESEC1', name: 'secret-private', is_private: true, is_member: false, everyone: true, extra: bystanders(2, 'SEC') },
  { id: 'C0FAKEPROJ', name: 'proj-demo-main', is_member: true, everyone: true, extra: [] },
  { id: 'C0FAKEEXT1', name: 'partner-shared', is_ext_shared: true, everyone: true, extra: bystanders(6, 'EXT') },
];

export function fakeSlackId(userId: string): string {
  return `UFAKE${userId.replace(/[^a-z0-9]/gi, '').slice(-8).toUpperCase()}`;
}

export interface FakeWorkspace {
  client: LinkSlackClient & PickerSlackClient;
  botUserId: string;
  /** The channels, by id, for tests that change them. */
  channels: Map<string, FakeChannel>;
  /** The store, with every user given a fake Slack id (and made a member of the `everyone` channels). */
  wrapStore<T extends Pick<SpaceSlackStore, 'slackIdsOf'>>(store: T): T;
}

let shared: FakeWorkspace | null = null;

/** The process's fake workspace (one per process, so links and members persist across requests). */
export function fakeWorkspace(): FakeWorkspace {
  shared ??= createFakeWorkspace();
  return shared;
}

/** A new fake workspace, seeded; tests make their own. */
export function createFakeWorkspace(): FakeWorkspace {
  const ws = fakeSlackWorkspace('UFAKEBOT01');
  const everyone = new Set<string>();
  for (const c of SEED) {
    ws.add({ id: c.id, name: c.name, is_private: !!c.is_private, is_member: !!c.is_member, is_ext_shared: !!c.is_ext_shared, members: [...c.extra] });
    if (c.everyone) everyone.add(c.id);
  }
  const register = (slackId: string) => {
    for (const id of everyone) {
      const ch = ws.channels.get(id);
      if (ch && !ch.members.includes(slackId)) ch.members.push(slackId);
    }
  };
  const conversations = ws.client.conversations as unknown as Record<string, unknown>;
  const create = ws.client.conversations.create;
  conversations.create = async (args: { name: string; is_private: boolean }) => {
    const before = new Set(ws.channels.keys());
    await create(args);
    // Swap the testkit's sequential id for a random one, so a restart can't reuse an id a link row still holds.
    const made = [...ws.channels.keys()].find(k => !before.has(k))!;
    const id = `C0FAKE${randomBytes(3).toString('hex').toUpperCase()}`;
    ws.channels.set(id, { ...ws.channels.get(made)!, id });
    ws.channels.delete(made);
    console.log(`[fake Slack] created #${args.name} (${id}, ${args.is_private ? 'private' : 'public'})`);
    return { channel: { id } };
  };
  conversations.list = async () => ({
    channels: [...ws.channels.values()]
      .filter(c => !c.is_archived && (!c.is_private || c.is_member))
      .map(({ members, ...info }) => ({ ...info, num_members: members.length })),
    response_metadata: { next_cursor: '' },
  });
  (ws.client.chat as Record<string, unknown>).postMessage = async ({ channel, text }: { channel: string; text: string }) => {
    console.log(`[fake Slack] #${ws.channels.get(channel)?.name ?? channel}: ${text}`);
    return { ts: `${Math.floor(Date.now() / 1000)}.000100` };
  };
  return {
    client: ws.client as unknown as LinkSlackClient & PickerSlackClient,
    botUserId: ws.botUserId,
    channels: ws.channels,
    wrapStore(store) {
      async function slackIdsOf(userIds: string[]) {
        const real = await store.slackIdsOf(userIds);
        return new Map(userIds.map(id => {
          const slackId = real.get(id) ?? fakeSlackId(id);
          register(slackId);
          return [id, slackId] as const;
        }));
      }
      // Every other method runs on the store itself, so a stateful store's writes land there.
      return new Proxy(store, {
        get(target, prop) {
          if (prop === 'slackIdsOf') return slackIdsOf;
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}
