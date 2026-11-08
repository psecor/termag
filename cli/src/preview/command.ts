import type { Api, Project } from '../api.js';
import { hasWorkstream, projectOfCwd } from './checkout.js';
import type { CommandSpec, ParsedArgs } from '../args.js';
import { authedApi, session } from '../commands.js';
import type { Ctx } from '../context.js';
import { CliError, EXIT, usage, type ExitCode } from '../errors.js';
import { confirmOrRefuse, resolveProject } from '../lifecycle.js';
import { formatDate, json, table } from '../output.js';

/**
 * `termag preview publish|list|revoke`
 * ("CLI"; PRD P6): a port of a workstream's box at
 * https://<name>.<preview domain>, for the people its audience names, until
 * it expires. The orchestrator's /api/cli/v1/preview-links
 * (routes/cliPreviewLinks.ts) takes a device sign-in only: on a box, run
 * `termag login --device <name>` first (a plain `termag login` there keeps the
 * box's own credentials, which are refused). An
 * agent can only ask for a link (`termag preview request`, phase 3).
 */

const REF_RE = /^[^/@\s]+\/[^/@\s]+(@[A-Za-z0-9_-]+)?$/;
const AUDIENCES = ['owner', 'people', 'link'] as const;
const AUDIENCE_TEXT: Record<string, string> = {
  owner: "you and the project's collaborators",
  people: 'the people named, you and the project\'s collaborators',
  link: 'anyone signed in to termag with the link',
};

export const PREVIEW_COMMANDS: Record<string, CommandSpec> = {
  'preview publish': {
    summary: 'Publish a port of a workstream\'s box at https://<name>.<preview domain>',
    usage: 'termag preview publish [<box>/<project>[@<workstream>]] <port> [--name <name>] [--audience owner|people|link] [--email <address>]… [--ttl <hours>] [--public-host]',
    details: '--name is the hostname label: 3 to 40 of a-z, 0-9 and -, suggested from the project and workstream.\n'
      + '--audience owner (the default) is you and the project\'s collaborators; people adds each --email;\n'
      + 'link is anyone signed in to termag with the link, whose token is printed once.\n'
      + '--ttl is 1 to 168 hours (default 24). --public-host sends the app the public Host instead of\n'
      + 'localhost:<port>. Publishing a name again for the same workstream renews it.\n'
      + 'With <port> alone, the project and workstream are the checkout you are in, on its box.\n'
      + 'From a sign-in made on a box, --audience people or link prints a link to confirm in your browser\n'
      + 'and waits for it: anything on the box can use that sign-in, so it can\'t share beyond you alone.\n'
      + '  termag preview publish 5173\n'
      + '  termag preview publish devbox/webapp@feature-x 5173 --name webapp-feature-x',
    options: {
      name: { type: 'string' },
      audience: { type: 'string' },
      email: { type: 'string', multiple: true },
      ttl: { type: 'string' },
      'public-host': { type: 'boolean' },
    },
    maxArgs: 2,
  },
  'preview list': {
    summary: 'List your live preview links, or a project\'s links and pending requests',
    usage: 'termag preview list [<box>/<project>]',
    maxArgs: 1,
  },
  'preview revoke': {
    summary: 'Revoke one of your preview links by its name',
    usage: 'termag preview revoke <name> [--yes]',
    maxArgs: 1,
  },
};

export interface PreviewLinkView {
  id: string;
  name: string;
  projectId: string;
  workstream?: string;
  port: number;
  audience: string;
  hostMode: string;
  live: boolean;
  expiresAt: string;
  endedAt: string | null;
  endReason: string | null;
  url: string;
  host: string | null;
  owner?: { email: string };
  viewers?: Array<{ email: string; lastOpenedAt: string; revokedAt: string | null }>;
}

interface PublishResponse {
  link: PreviewLinkView;
  renewed: boolean;
  shareUrl: string | null;
  note?: string;
}

/** A name from the project and workstream, as the orchestrator suggests it: null when nothing usable is left. */
export function suggestName(project: string, workstream: string): string | null {
  const raw = workstream === 'main' ? project : `${project}-${workstream}`;
  const label = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
  return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(label) ? label : null;
}

/** The orchestrator's 404 for a project it won't publish from: off, or not the caller's. */
function previewsOff(err: unknown, where: string): never {
  if (err instanceof CliError && err.code === 'not_found' && err.body?.code === 'not_found' && err.message === 'Not found') {
    throw new CliError('not_found', `Preview links aren't available for ${where} (they're off, or it isn't your project or shared with you)`, err.status, err.body);
  }
  throw err;
}

async function namedProject(api: Api, ref: string): Promise<{ project: Project; workstream: string }> {
  const [projectRef, workstream = 'main'] = ref.split('@');
  const project = await resolveProject(api, projectRef);
  if (!hasWorkstream(project, workstream)) {
    throw new CliError('not_found', `No workstream "${workstream}" in ${project.ref} (it has ${project.workstreams.join(', ')})`);
  }
  return { project, workstream };
}

async function cmdPublish(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  // `<port>` alone: the project and workstream are the working directory's checkout (P6).
  const [ref, portRaw] = args.args.length === 1 ? [null, args.args[0]] : args.args;
  if (!portRaw) throw usage(`Name a port. Usage: ${PREVIEW_COMMANDS['preview publish'].usage}`);
  if (ref !== null && !REF_RE.test(ref)) throw usage(`"${ref}" is not <box>/<project> or <box>/<project>@<workstream>`);
  const port = Number(portRaw);
  if (!/^\d+$/.test(portRaw) || port < 1 || port > 65535) throw usage(`"${portRaw}" is not a port (1 to 65535)`);
  const audience = args.options.audience ?? 'owner';
  if (typeof audience !== 'string' || !(AUDIENCES as readonly string[]).includes(audience)) throw usage(`--audience takes ${AUDIENCES.join(', ')}`);
  const emails = args.lists.email ?? [];
  if (audience === 'people' && emails.length === 0) throw usage('--audience people needs at least one --email');
  if (audience === 'owner' && emails.length > 0) throw usage('--email names people for --audience people or link');
  let ttlHours: number | undefined;
  if (args.options.ttl !== undefined) {
    ttlHours = Number(args.options.ttl);
    if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) throw usage('--ttl takes a whole number of hours, 1 to 168');
  }

  const s = session(ctx, args);
  const api = await authedApi(ctx, s);
  const { project, workstream } = ref === null ? await projectOfCwd(ctx, s, api) : await namedProject(api, ref);
  const name = typeof args.options.name === 'string' ? args.options.name : suggestName(project.name, workstream);
  if (!name) throw usage('Name the link with --name (3 to 40 of a-z, 0-9 and -)');

  let published: PublishResponse | ConfirmResponse;
  try {
    published = await api.request<PublishResponse>('POST', '/preview-links', {
      project: project.id, workstream, port, name, audience,
      ...(emails.length ? { emails } : {}),
      ...(ttlHours !== undefined ? { ttlHours } : {}),
      ...(args.options['public-host'] ? { hostMode: 'public' } : {}),
    });
  } catch (err) {
    previewsOff(err, project.ref);
  }
  const where = workstream === 'main' ? project.ref : `${project.ref}@${workstream}`;
  if (isConfirm(published)) {
    // A sign-in made on a box: sharing beyond "only me" waits for the person's click.
    const confirmed = await waitForConfirm(ctx, api, published, !!args.json);
    if (args.json) { ctx.out(json(confirmed)); return EXIT.OK; }
    if (!confirmed.link) throw new CliError('failed', 'The confirm finished with no link');
    ctx.out(`Published port ${confirmed.link.port} of ${where} as ${confirmed.link.name}, for ${AUDIENCE_TEXT[confirmed.link.audience] ?? confirmed.link.audience}, until ${formatDate(confirmed.link.expiresAt)}.`);
    ctx.out(confirmed.shareUrl
      ? `Share this link; it carries the link's token and is shown only now:\n  ${confirmed.shareUrl}`
      : `Share: ${confirmed.link.url}`);
    return EXIT.OK;
  }
  if (args.json) { ctx.out(json(published)); return EXIT.OK; }
  const { link } = published;
  ctx.out(`${published.renewed ? 'Renewed' : 'Published'} port ${link.port} of ${where} as ${link.name}, for ${AUDIENCE_TEXT[link.audience] ?? link.audience}, until ${formatDate(link.expiresAt)}.`);
  if (published.shareUrl) {
    ctx.out(link.audience === 'link' && published.shareUrl !== link.url
      ? `Share this link; it carries the link's token and is shown only now:\n  ${published.shareUrl}`
      : `Share: ${published.shareUrl}`);
  } else if (published.note) {
    ctx.out(published.note);
  }
  if (link.host) ctx.out(`The app is served at https://${link.host}/`);
  return EXIT.OK;
}

interface ConfirmResponse {
  confirm: { url: string; expiresAt: string; status: string };
  audience: string;
  emails: string[];
}

interface ConfirmStatus {
  state: 'pending' | 'confirmed' | 'declined' | 'expired' | 'failed';
  expiresAt: string;
  failure: string | null;
  link: { id: string; name: string; port: number; audience: string; expiresAt: string; url: string } | null;
  shareUrl: string | null;
}

function isConfirm(r: unknown): r is ConfirmResponse {
  return !!r && typeof r === 'object' && 'confirm' in r;
}

const CONFIRM_POLL_MS = 3_000;
// The confirm lives 10 minutes; a little longer covers the clocks' skew.
const CONFIRM_WAIT_MS = 11 * 60_000;

/** Print the confirm link, then wait for the person's Publish or Decline in their browser. */
async function waitForConfirm(ctx: Ctx, api: Api, c: ConfirmResponse, quiet: boolean): Promise<ConfirmStatus> {
  const who = c.audience === 'people' && c.emails.length ? c.emails.join(', ') : AUDIENCE_TEXT[c.audience] ?? c.audience;
  const say = quiet ? ctx.err : ctx.out;
  say(`Open this link to confirm sharing with ${who}: ${c.confirm.url}`);
  say('(This sign-in was made on a box, so sharing beyond you needs your click in the browser. Waiting…)');
  const deadline = Date.now() + CONFIRM_WAIT_MS;
  const every = ctx.pollIntervalMs ?? CONFIRM_POLL_MS;
  for (;;) {
    const s = await api.request<ConfirmStatus>('GET', c.confirm.status);
    if (s.state === 'confirmed') return s;
    if (s.state === 'declined') throw new CliError('failed', 'Declined in the browser; nothing was published');
    if (s.state === 'expired') throw new CliError('timeout', 'The confirm link expired after 10 minutes; nothing was published. Run the command again');
    if (s.state === 'failed') throw new CliError('failed', `Confirmed, but the publish was refused: ${s.failure ?? 'no reason given'}`);
    if (Date.now() >= deadline) throw new CliError('timeout', 'Gave up waiting for the confirm; nothing was published');
    await new Promise(resolve => setTimeout(resolve, Math.min(every, Math.max(0, deadline - Date.now()))));
  }
}

function linkRows(links: PreviewLinkView[]): string[][] {
  return links.map(l => [
    l.name,
    String(l.port),
    l.workstream ?? '-',
    l.audience,
    l.live ? formatDate(l.expiresAt) : (l.endReason ?? 'ended'),
    String(l.viewers?.filter(v => !v.revokedAt).length ?? 0),
    l.url,
  ]);
}

async function cmdList(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = args.args[0];
  const api = await authedApi(ctx, session(ctx, args));
  if (ref === undefined) {
    const { links } = await api.request<{ links: PreviewLinkView[] }>('GET', '/preview-links');
    if (args.json) { ctx.out(json({ links })); return EXIT.OK; }
    if (links.length === 0) { ctx.out('No live preview links. Publish one with `termag preview publish <port>` in a checkout on its box, or `termag preview publish <box>/<project> <port>`.'); return EXIT.OK; }
    ctx.out(table(['NAME', 'PORT', 'WORKSTREAM', 'AUDIENCE', 'EXPIRES', 'VIEWERS', 'URL'], linkRows(links)));
    return EXIT.OK;
  }
  if (!REF_RE.test(ref) || ref.includes('@')) throw usage(`"${ref}" is not <box>/<project>`);
  const project = await resolveProject(api, ref);
  let listed: { links: PreviewLinkView[]; requests: Array<{ id: string; port: number; note: string | null; createdAt: string }> };
  try {
    listed = await api.request('GET', `/preview-links?project=${encodeURIComponent(project.id)}`);
  } catch (err) {
    previewsOff(err, project.ref);
  }
  if (args.json) { ctx.out(json(listed)); return EXIT.OK; }
  if (listed.links.length === 0) ctx.out(`No preview links in ${project.ref}.`);
  else ctx.out(table(['NAME', 'PORT', 'WORKSTREAM', 'AUDIENCE', 'EXPIRES', 'VIEWERS', 'URL'], linkRows(listed.links)));
  if (listed.requests.length) {
    ctx.out('');
    ctx.out('Pending agent requests (publish one in the web UI):');
    // The agent's note is its own words: shown as given, after the port.
    for (const r of listed.requests) ctx.out(`  port ${r.port}${r.note ? `: ${JSON.stringify(r.note)}` : ''} (${formatDate(r.createdAt)})`);
  }
  return EXIT.OK;
}

async function findOwnLink(api: Api, name: string): Promise<PreviewLinkView> {
  const { links } = await api.request<{ links: PreviewLinkView[] }>('GET', '/preview-links');
  const link = links.find(l => l.name === name);
  if (!link) throw new CliError('not_found', `You have no live preview link named "${name}". Run \`termag preview list\`.`);
  return link;
}

async function cmdRevoke(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const name = args.args[0];
  if (!name) throw usage(`Name the link. Usage: ${PREVIEW_COMMANDS['preview revoke'].usage}`);
  const api = await authedApi(ctx, session(ctx, args));
  const link = await findOwnLink(api, name);
  await confirmOrRefuse(ctx, args, `Revoke ${link.name} (port ${link.port}), ending it for everyone using it?`);
  const { link: ended } = await api.request<{ link: PreviewLinkView }>('DELETE', `/preview-links/${encodeURIComponent(link.id)}`);
  if (args.json) ctx.out(json({ link: ended }));
  else ctx.out(`Revoked ${ended.name}. The name stays yours for 30 days.`);
  return EXIT.OK;
}

export const PREVIEW_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  'preview publish': cmdPublish,
  'preview list': cmdList,
  'preview revoke': cmdRevoke,
};
