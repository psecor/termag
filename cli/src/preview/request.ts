import { Api } from '../api.js';
import type { CommandSpec, ParsedArgs } from '../args.js';
import { session } from '../commands.js';
import type { Ctx } from '../context.js';
import { CliError, EXIT, usage, type ExitCode } from '../errors.js';
import { checkoutOf } from './checkout.js';

/**
 * `termag preview request <port> [--note <text>]`
 * ("CLI"; PRD P4): an agent on a box asks the box's owner to share a port of
 * the checkout it works in as a preview link. It can only ask. The owner is
 * told in termag and on Slack, and chooses whether, for whom and how long;
 * the agent sees no link. It goes with the box's own credentials, whoever is
 * signed in on the box, since a person publishes with `termag preview publish`.
 */
export const REQUEST_COMMANDS: Record<string, CommandSpec> = {
  'preview request': {
    summary: 'Ask the box\'s owner to share a port as a preview link (for agents on a box)',
    usage: 'termag preview request <port> [--note <text>]',
    details: 'Run it in a workstream\'s checkout on its box. The owner sees the request in the project\'s Share\n'
      + 'dialog and on Slack, and publishes it (for them and the project\'s collaborators only, to start with) or\n'
      + 'declines it. It waits 24 hours.\n'
      + '--note says what the port is, up to 200 characters; the owner sees it as your words.\n'
      + 'A box can ask 10 times an hour. Asking again for the same port says where the request stands: still\n'
      + 'waiting, or published, declined or expired, and when. Once it was answered, the owner isn\'t asked again\n'
      + 'for 12 hours, so don\'t ask again in a loop.\n'
      + '  termag preview request 5173 --note "the Vite dev server for the checkout page"',
    options: { note: { type: 'string' } },
    maxArgs: 1,
  },
};

interface Asked {
  /** pending, or how the owner answered lately: approved, declined, expired. */
  state: 'pending' | 'approved' | 'declined' | 'expired';
  repeated?: boolean;
  decidedAt?: string | null;
  /** When the owner may be asked about this port again (an answered request only). */
  askAgainAfter?: string;
  request: { id: string; port: number; note: string | null; expiresAt: string };
}

const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

async function cmdRequest(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const raw = args.args[0];
  if (!raw) throw usage(`Name a port. Usage: ${REQUEST_COMMANDS['preview request'].usage}`);
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) throw usage(`"${raw}" is not a port (1 to 65535)`);
  const at = checkoutOf((ctx.cwd ?? (() => process.cwd()))(), ctx.home);
  if (!at) throw usage("Run this in a workstream's checkout on its box (~/termag/projects/<project>)");
  const s = session(ctx, args);
  const box = s.target.box;
  if (!box) throw new CliError('usage', "This isn't a termag box: `termag preview request` asks a box's owner, from the box");
  const api = new Api({ host: s.target.host, token: box.token, fetch: ctx.fetch });
  const note = typeof args.options.note === 'string' ? args.options.note : undefined;
  const asked = await api.request<Asked>('POST', '/preview-link-requests', {
    project: at.project, workstream: at.workstream, port, ...(note !== undefined ? { note } : {}),
  }).catch((err: unknown) => {
    if (err instanceof CliError && err.code === 'not_found' && (err.body as { code?: string } | undefined)?.code === 'not_found') {
      throw new CliError('not_found', `Preview link requests aren't available for ${at.project} (they're off, or the project isn't on this box)`, err.status, err.body);
    }
    throw err;
  });
  if (args.json) { ctx.out(JSON.stringify(asked)); return EXIT.OK; }
  const where = at.workstream === 'main' ? at.project : `${at.project}@${at.workstream}`;
  if (asked.state !== 'pending') {
    // Answered lately (#1568): say how and when, so the agent stops asking. Never the link: only the
    // owner has it.
    const when = asked.decidedAt ? ` at ${utc(asked.decidedAt)}` : '';
    const how = asked.state === 'approved'
      ? `The owner published port ${port} of ${where}${when}. Ask them for the link; it isn't shown here.`
      : asked.state === 'declined'
        ? `The owner declined sharing port ${port} of ${where}${when}.`
        : `The request to share port ${port} of ${where} expired${when} without an answer.`;
    ctx.out(`${how} (request ${asked.request.id})`);
    if (asked.askAgainAfter) ctx.out(`They won't be asked about this port again before ${utc(asked.askAgainAfter)}.`);
    return EXIT.OK;
  }
  ctx.out(asked.repeated
    ? `Port ${port} of ${where} is already waiting for the owner (request ${asked.request.id}).`
    : `Asked the box's owner to share port ${port} of ${where} (request ${asked.request.id}).`);
  ctx.out(`They decide in termag or on Slack, until ${utc(asked.request.expiresAt)}. Nothing is shared until they do.`);
  return EXIT.OK;
}

export const REQUEST_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  'preview request': cmdRequest,
};
