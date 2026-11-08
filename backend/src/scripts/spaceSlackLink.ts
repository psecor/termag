/**
 * Drive the link service (services/spaceSlack/link.ts) by hand, before its
 * entry points exist (M5b's `/t link`, M5c's shortcut and App Home, M6's API
 * and CLI). For staging and development only.
 *
 *   tsx src/scripts/spaceSlackLink.ts link <space> <channelId> --as <email> [--preview] [--via slack_command|web|cli|…]
 *   tsx src/scripts/spaceSlackLink.ts create <space> <name> --as <email> [--private] [--invite-members] [--preview]
 *   tsx src/scripts/spaceSlackLink.ts unlink <channelId> --as <email> [--archive] [--preview]
 *
 * With SLACK_BOT_TOKEN set it calls Slack. Without it (or with --fake-slack) it
 * runs against a fake workspace holding the one channel, with the actor in it
 * (`--name <channel>`, `--private`, `--not-invited` for a private channel
 * termag isn't in, `--not-member` for one the actor isn't in). The rows and the
 * space's audit events are real either way. Prints the result as JSON.
 * The flag is read as everywhere: under AUTH_MODE=local, set
 * TERMAG_FLAGS='{"space-channels-enabled":true}'.
 */
import 'dotenv/config';
import '../config/bootstrap';
import { WebClient } from '@slack/web-api';
import { prisma } from '../db';
import { closeFeatureFlags, initFeatureFlags } from '../services/featureFlags';
import { link, unlink, type LinkActor, type LinkDeps, type LinkSlackClient, type LinkVia } from '../services/spaceSlack/link';
import { prismaSpaceSlackStore } from '../services/spaceSlack/linkStore';
import { spaceSlackLinkDeps } from '../services/spaceSlack/runtime';
import { fakeSlackWorkspace } from '../services/spaceSlack/spaceSlackTestkit';
import { findUserByEmail } from '../services/userByEmail';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.match(/^--(as|via|name)$/));
  const has = (name: string) => rest.includes(name);
  const email = flag(rest, '--as');
  if (!cmd || !email || !['link', 'create', 'unlink'].includes(cmd)) {
    console.error('usage: spaceSlackLink.ts link <space> <channelId> | create <space> <name> | unlink <channelId>  --as <email> [--preview] …');
    return 2;
  }
  const user = await findUserByEmail(email);
  if (!user) { console.error(`No termag user has the email ${email}`); return 2; }

  await initFeatureFlags();
  const fake = has('--fake-slack') || !process.env.SLACK_BOT_TOKEN;
  const actor: LinkActor = { userId: user.id, slackId: user.slackUserId ?? (fake ? `UFAKE${user.id.slice(-6).toUpperCase()}` : undefined) };
  const deps: LinkDeps = spaceSlackLinkDeps();
  if (fake) {
    const ws = fakeSlackWorkspace();
    const channelId = cmd === 'link' ? positional[1] : cmd === 'unlink' ? positional[0] : undefined;
    if (channelId) {
      const known = await prismaSpaceSlackStore.channel(channelId);
      const isPrivate = has('--private') || !!known?.isPrivate;
      ws.add({
        id: channelId, name: flag(rest, '--name') ?? known?.name ?? `fake-${channelId.toLowerCase()}`, is_private: isPrivate,
        is_member: !!known && !known.unlinkedAt ? true : !(isPrivate && has('--not-invited')),
        members: has('--not-member') ? ['UBYSTAND1'] : [actor.slackId!, 'UBYSTAND1', 'UBYSTAND2'],
      });
    }
    deps.slack = ws.client;
    deps.botUserId = ws.botUserId;
    console.error('[fake Slack] no Slack calls are made; rows and audit events are real');
  } else if (!deps.slack) {
    deps.slack = new WebClient(process.env.SLACK_BOT_TOKEN) as unknown as LinkSlackClient;
  }

  const preview = has('--preview');
  const via = (flag(rest, '--via') ?? 'cli') as LinkVia;
  let result: unknown;
  if (cmd === 'link') {
    result = await link(deps, { spaceName: positional[0], channelId: positional[1], actor, via, mode: preview ? 'preview' : 'commit' });
  } else if (cmd === 'create') {
    result = await link(deps, {
      spaceName: positional[0], actor, via, mode: preview ? 'preview' : 'commit',
      create: { name: positional[1], private: has('--private'), inviteMembers: has('--invite-members') },
    });
  } else {
    result = await unlink(deps, { channelId: positional[0], actor, via, reason: 'owner', archive: has('--archive'), mode: preview ? 'preview' : 'commit' });
  }
  console.log(JSON.stringify(result, null, 2));
  return (result as { kind: string }).kind === 'refused' ? 1 : 0;
}

main()
  .then(code => { process.exitCode = code; })
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(async () => { await closeFeatureFlags().catch(() => {}); await prisma.$disconnect(); });
