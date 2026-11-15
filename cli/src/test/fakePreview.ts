import type { ServerResponse } from 'node:http';

/**
 * The orchestrator's preview link routes on /api/cli/v1 (backend
 * routes/cliPreviewLinks.ts): a device sign-in's only, so a box token gets
 * 403 forbidden, worded by route as there.
 */
export interface FakePreviewState {
  /** The bodies POSTed, newest last. */
  posts: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
  requests: Array<Record<string, unknown>>;
  deleted: string[];
  /** Answer the next POST with this error instead (e.g. 409 name_taken). */
  refuse: { status: number; error: string; code: string } | null;
  /** A box-made sign-in's wider publish: the confirm's states, one per poll; the last one sticks. */
  confirmStates: string[];
  polls: number;
  /** `termag preview request` bodies, newest last. */
  requestPosts: Array<Record<string, unknown>>;
  /** A request the owner answered lately, by port: a repeat for it gets this, as the orchestrator answers. */
  answered: Record<number, { state: string; decidedAt: string; askAgainAfter: string }>;
}

export function newPreviewState(): FakePreviewState {
  return { posts: [], links: [], requests: [], deleted: [], refuse: null, confirmStates: ['pending', 'confirmed'], polls: 0, requestPosts: [], answered: {} };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

/** The backend's boxRefused (routes/cliPreviewLinks.ts), for the routes the CLI calls. */
function boxRefusal(route: string): string {
  const why = '(anything on the box can use them)';
  const signIn = 'sign in on the box with `termag login --device <name>`';
  if (/^GET \/preview-links\/confirmations\//.test(route)) {
    return `A box's own credentials can't read a preview link's confirmation ${why}; the owner confirms or declines it in their browser, and the \`termag preview publish\` that asked for it reads it with the owner's own sign-in`;
  }
  if (route.startsWith('GET ')) return `A box's own credentials can't read preview links ${why}; ask the owner to look in termag's Share dialog or run their own \`termag preview list\`, or ${signIn}`;
  if (route.startsWith('DELETE ')) return `A box's own credentials can't revoke a preview link ${why}; ask the owner to revoke it from termag's Share dialog or their own \`termag preview revoke\`, or ${signIn}`;
  return `A box's own credentials can't publish a preview link ${why}; the owner publishes from termag's Share dialog or their own \`termag preview publish\`; ${signIn}, or ask the owner with \`termag preview request\``;
}

const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA';

export function handlePreview(s: FakePreviewState, route: string, query: URLSearchParams, body: Record<string, unknown>, isBox: boolean, res: ServerResponse, onBox = false): boolean {
  // `termag preview request`: a box's own token only, as routes/cliPreviewLinks.ts has it.
  if (route === 'POST /preview-link-requests') {
    if (!isBox) { send(res, 403, { error: '`termag preview request` is for an agent on a box', code: 'forbidden' }); return true; }
    s.requestPosts.push(body);
    const repeated = s.requests.find(r => r.port === body.port && r.project === body.project);
    const answer = s.answered[body.port as number];
    if (repeated && answer) { send(res, 200, { ...answer, request: repeated, repeated: true }); return true; }
    const request = repeated ?? { id: `creq${String(s.requests.length + 1).padStart(8, '0')}`, port: body.port, project: body.project, note: body.note ?? null, expiresAt: '2026-11-02T12:00:00.000Z' };
    if (!repeated) s.requests.push(request);
    send(res, repeated ? 200 : 201, { state: 'pending', request, ...(repeated ? { repeated: true } : {}) });
    return true;
  }
  if (!/^(GET|POST|DELETE) \/preview-links(\/|$)/.test(route)) return false;
  if (isBox) {
    send(res, 403, { error: boxRefusal(route), code: 'forbidden' });
    return true;
  }
  const poll = route.match(/^GET \/preview-links\/confirmations\/([^/]+)$/);
  if (poll) {
    const state = s.confirmStates[Math.min(s.polls++, s.confirmStates.length - 1)];
    const link = { id: 'clink9', name: 'wide-app', port: 5173, audience: 'link', expiresAt: '2026-11-01T12:00:00.000Z', url: 'https://termag.example/termag/previews/wide-app' };
    send(res, 200, { state, expiresAt: '2026-11-04T12:10:00.000Z', failure: state === 'failed' ? '"wide-app" is taken' : null, link: state === 'confirmed' ? link : null, shareUrl: state === 'confirmed' ? `${link.url}/${TOKEN}` : null });
    return true;
  }
  if (route === 'POST /preview-links') {
    s.posts.push(body);
    if (onBox && body.audience !== 'owner') {
      send(res, 202, { code: 'confirm_in_browser', audience: body.audience, emails: body.emails ?? [], confirm: { url: 'https://termag.example/termag/previews/confirm/' + 'C'.repeat(43), expiresAt: '2026-11-04T12:10:00.000Z', status: '/preview-links/confirmations/' + 'C'.repeat(43) } });
      return true;
    }
    if (s.refuse) { const r = s.refuse; s.refuse = null; send(res, r.status, { error: r.error, code: r.code }); return true; }
    const existing = s.links.find(l => l.name === body.name && l.live);
    const link = {
      id: existing?.id ?? `clink${s.links.length + 1}`, name: body.name, projectId: body.project, workstream: body.workstream, port: body.port,
      audience: body.audience, hostMode: body.hostMode ?? 'localhost', live: true, expiresAt: '2026-11-01T12:00:00.000Z', endedAt: null, endReason: null,
      url: `https://termag.example/termag/previews/${body.name}`, host: `${body.name}.previews.example`, viewers: [],
    };
    if (existing) Object.assign(existing, link); else s.links.push(link);
    const tokenKept = !!existing && body.audience === 'link' && existing.audience === 'link';
    send(res, existing ? 200 : 201, {
      link, renewed: !!existing,
      shareUrl: tokenKept ? null : body.audience === 'link' ? `${link.url}/${TOKEN}` : link.url,
      ...(tokenKept ? { note: 'The link keeps its token; share the URL you were given when it was made' } : {}),
    });
    return true;
  }
  if (route === 'GET /preview-links') {
    const project = query.get('project');
    if (project) send(res, 200, { links: s.links.filter(l => l.projectId === project), requests: s.requests });
    else send(res, 200, { links: s.links.filter(l => l.live) });
    return true;
  }
  const del = route.match(/^DELETE \/preview-links\/([^/]+)$/);
  if (del) {
    const link = s.links.find(l => l.id === decodeURIComponent(del[1]));
    if (!link) { send(res, 404, { error: 'Not found', code: 'not_found' }); return true; }
    s.deleted.push(link.id as string);
    Object.assign(link, { live: false, endedAt: '2026-10-31T12:00:00.000Z', endReason: 'revoked' });
    send(res, 200, { link });
    return true;
  }
  return false;
}
