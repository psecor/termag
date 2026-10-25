import express, { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { requireAuthOrAgentToken } from '../middleware/auth';
import { sendForProject, isProjectAgentConnected } from '../services/agentRegistry';
import { noteBoxActivity } from '../services/boxActivity';
import { assertSessionAccess, SessionAccessError } from '../services/sessionAccess';
import { collectSessionRows, inventoryInclude } from '../services/sessionInventory';
import {
  liveSearchDeps, parseRoles, searchSessions, SEARCH_DEFAULT_LINES, SEARCH_MAX_QUERY, SEARCH_MIN_QUERY,
  type SearchDeps, type SearchResult,
} from '../services/sessionSearch';

// Permissioned, token-friendly session surface for non-browser callers — built
// for the MetaTerm MCP server, usable by anything holding a Bearer agent token.
// Everything goes through assertSessionAccess (owner-OR-share + rebuild the
// legal session name) and is routed to the OWNER's per-user agent via
// sendForProject, because tmux is per-unix-user and the backend can't touch
// another user's sessions in-process.

const SEND_MIN_INTERVAL_MS = 500;
const sendRateLimits = new Map<string, number>();

// Pane-text search fans out one capture per live pane, so it gets its own
// budget per caller instead of riding the 1/s per-pane capture limit; a
// repeat of the same search inside the cache window costs nothing.
const SEARCH_MIN_INTERVAL_MS = 3_000;
const SEARCH_CACHE_MS = 15_000;
const searchRateLimits = new Map<string, number>();
const searchCache = new Map<string, { at: number; result: SearchResult }>();

// The phone's "attach a photo". 20 MiB matches the
// agent's CLIPBOARD_MAX_BYTES (agent/clipboard-mailbox.js) and the desktop
// paste's cap; the parser's limit sits a little above it so an image just over
// gets this route's 413 rather than body-parser's.
export const PASTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const PASTE_IMAGE_MIN_INTERVAL_MS = 2_000;
// A 27 MiB base64 frame to the agent, then a file write and one tmux call.
const PASTE_IMAGE_TIMEOUT_MS = 30_000;
const pasteRateLimits = new Map<string, number>();
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PASTE_TOO_LARGE = `Image too large (max ${PASTE_IMAGE_MAX_BYTES / 1024 / 1024} MiB)`;

// The terminal's hover preview of an image path in a pane. The agent reads at
// most 10 MiB (agent/read-image.js) and names the type from the file's magic
// bytes; it is checked again here so nothing but these ever goes out.
const READ_IMAGE_TIMEOUT_MS = 15_000;
const READ_IMAGE_MAX_PATH = 4096;
const READ_IMAGE_MAX_IN_FLIGHT = 4;
const READ_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const readImageInFlight = new Map<string, number>();

// express.raw on this route only. The app-wide express.json() parses
// application/json bodies alone, so an image/png body reaches this untouched.
const rawPng = express.raw({ type: 'image/png', limit: '21mb' });
const pngBody: RequestHandler = (req, res, next) => {
  rawPng(req, res, (err?: unknown) => {
    if (err && (err as { status?: unknown }).status === 413) {
      res.status(413).json({ error: PASTE_TOO_LARGE });
      return;
    }
    next(err);
  });
};

export function sessionsRouter(): Router {
  const router = Router();

  // GET /api/sessions — every session the caller may reach: own + shared
  // projects × live workstreams × roles, with agent connectivity, tmux
  // liveness (one tmux-list per distinct host) and the current status.
  const list: RequestHandler = async (req, res) => {
    res.json(await listSessionRowsFor(req.user!.id, req.agentInstanceId));
  };

  // POST /api/projects/:id/sessions/:role/send-keys { workstream?, keys, enter?, literal? }
  // The missing "drive" primitive. Same guard + failure modes as capture.
  const sendKeys: RequestHandler = async (req, res) => {
    const result = await sendKeysFor(req.user!.id, req.params.id, req.params.role, req.body, req.agentInstanceId ?? 'browser');
    res.status(result.status).json(result.body);
  };

  const pasteImage: RequestHandler = async (req, res) => {
    const result = await pasteImageFor(
      req.user!.id, req.params.id, req.params.role, req.query.workstream, req.body, req.agentInstanceId ?? 'browser',
    );
    res.status(result.status).json(result.body);
  };

  const readImage: RequestHandler = async (req, res) => {
    const result = await readImageFor(req.user!.id, req.params.id, req.query.workstream, req.query.path);
    if (!('image' in result)) {
      res.status(result.status).json(result.body);
      return;
    }
    res.set({
      'Content-Type': result.mime,
      // The pane can rewrite the same path (a re-taken screenshot); the
      // terminal keeps its own short cache instead.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'",
    });
    res.status(200).send(result.image);
  };

  // GET /api/sessions/search?q=&lines=&roles=agent,ctrl — pane text across
  // every reachable live session. Backs the phone's
  // Search tab and MetaTerm's search_sessions tool.
  const search: RequestHandler = async (req, res) => {
    const result = await searchFor(req.user!.id, req.query, req.agentInstanceId ?? 'browser');
    res.status(result.status).json(result.body);
  };

  router.get('/sessions/search', requireAuthOrAgentToken, search);
  router.get('/sessions', requireAuthOrAgentToken, list);
  router.post('/projects/:id/sessions/:role/send-keys', requireAuthOrAgentToken, sendKeys);
  // POST /api/projects/:id/sessions/:role/paste-image?workstream=  (body: image/png)
  // Same guard + failure modes as send-keys, plus 413 / 501.
  router.post('/projects/:id/sessions/:role/paste-image', requireAuthOrAgentToken, pngBody, pasteImage);
  // GET /api/projects/:id/image?workstream=&path=/abs/shot.png → the image bytes.
  // Same guard as send-keys; 404 for no such file, 415 for not an image, 501 for an old box.
  router.get('/projects/:id/image', requireAuthOrAgentToken, readImage);
  return router;
}

/**
 * Every session the user may reach: own + shared projects × live workstreams
 * × roles, with agent connectivity, tmux liveness (one tmux-list per distinct
 * host) and the current status. `callerInstanceId` is the box a box token
 * belongs to, which marks that box's rows.
 */
export async function listSessionRowsFor(userId: string, callerInstanceId?: string | null) {
  const owned = await prisma.project.findMany({ where: { userId, archived: false }, include: inventoryInclude });
  const shares = await prisma.projectShare.findMany({
    where: { userId },
    include: { project: { include: inventoryInclude } },
  });
  const rows = await collectSessionRows([
    ...owned.map(p => ({ p, access: 'owner' })),
    ...shares.filter(s => !s.project.archived).map(s => ({ p: s.project, access: 'collaborator' })),
  ], callerInstanceId);
  // ownerUserId is an admin-view field; the per-user payload stays as before.
  return rows.map(({ ownerUserId: _omit, ...r }) => r);
}

/** Type into a project session the user may reach (send-keys route, cookie or agent token). */
export async function sendKeysFor(
  userId: string, projectId: string, role: string, body: unknown,
  /** Who is sending, for the rate-limit key (see captureFor). */
  callerId: string = 'browser',
): Promise<{ status: number; body: unknown }> {
  const { workstream, keys, enter, literal } = (body ?? {}) as {
    workstream?: string; keys?: string; enter?: boolean; literal?: boolean;
  };
  if (typeof keys !== 'string' || keys.length === 0) {
    return { status: 400, body: { error: 'keys (non-empty string) required' } };
  }
  if (keys.length > 4000) {
    return { status: 400, body: { error: 'keys too long (max 4000 chars)' } };
  }
  let access;
  try {
    access = await assertSessionAccess(userId, projectId, role, workstream || 'main');
  } catch (err) {
    if (err instanceof SessionAccessError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
  if (!isProjectAgentConnected(access.host)) {
    return { status: 503, body: { error: "Owner's agent is offline" } };
  }
  // Per caller (see the capture route): token callers by box, browsers as one.
  const rateKey = `${userId}:${callerId}:${access.session}`;
  const now = Date.now();
  if (now - (sendRateLimits.get(rateKey) ?? 0) < SEND_MIN_INTERVAL_MS) {
    return { status: 429, body: { error: 'Rate limited (max 2 sends/sec per caller and session)' } };
  }
  sendRateLimits.set(rateKey, now);
  noteBoxActivity(access.host.instanceId);
  try {
    // literal (default true): type `keys` verbatim. literal:false sends tmux
    // KEY NAMES (C-c, Escape, Up…) — deliberate control-tower use only. Old
    // agents ignore the flag and keep their historical key-name behavior.
    await sendForProject(access.host, 'tmux-send-keys', {
      sessionName: access.session, keys, withEnter: enter !== false, literal: literal !== false,
    });
    return { status: 200, body: { ok: true, session: access.session } };
  } catch (err) {
    return { status: 503, body: { error: `send-keys failed: ${(err as Error).message}` } };
  }
}

/**
 * Paste a PNG into a project session the user may reach, as if it had been
 * pasted into the terminal (paste-image route, cookie or agent token). The
 * owner's agent writes the clipboard mailbox and sends Ctrl+V into the pane
 * (`clipboard-paste-image` RPC), which Claude Code reads as a pasted image.
 */
export async function pasteImageFor(
  userId: string, projectId: string, role: string, workstream: unknown, body: unknown,
  /** Who is pasting, for the rate-limit key (see captureFor). */
  callerId: string = 'browser',
  now: number = Date.now(),
): Promise<{ status: number; body: unknown }> {
  // express.raw leaves req.body alone (an empty object) for any other
  // Content-Type, and for an empty body.
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return { status: 400, body: { error: 'Send the image as the request body with Content-Type: image/png' } };
  }
  if (body.length > PASTE_IMAGE_MAX_BYTES) return { status: 413, body: { error: PASTE_TOO_LARGE } };
  if (body.length < PNG_MAGIC.length || !body.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return { status: 400, body: { error: 'Image is not a PNG' } };
  }
  let access;
  try {
    access = await assertSessionAccess(userId, projectId, role, typeof workstream === 'string' && workstream ? workstream : 'main');
  } catch (err) {
    if (err instanceof SessionAccessError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
  if (!isProjectAgentConnected(access.host)) {
    return { status: 503, body: { error: "Owner's agent is offline" } };
  }
  const rateKey = `${userId}:${callerId}:${access.session}`;
  if (now - (pasteRateLimits.get(rateKey) ?? 0) < PASTE_IMAGE_MIN_INTERVAL_MS) {
    return { status: 429, body: { error: 'Rate limited (max 1 image every 2s per caller and session)' } };
  }
  pasteRateLimits.set(rateKey, now);
  noteBoxActivity(access.host.instanceId);
  try {
    await sendForProject(access.host, 'clipboard-paste-image', {
      sessionName: access.session, data: body.toString('base64'),
    }, PASTE_IMAGE_TIMEOUT_MS);
    return { status: 200, body: { ok: true } };
  } catch (err) {
    const message = (err as Error).message;
    // An agent from before the RPC (agent.js `default:` case).
    if (message.startsWith('Unknown command: clipboard-paste-image')) {
      return { status: 501, body: { error: 'This box needs an update to take images' } };
    }
    return { status: 503, body: { error: `paste-image failed: ${message}` } };
  }
}

/**
 * Read an image file off a project's box for the terminal's hover preview
 * (image route). Anyone who may reach the project's sessions may read it:
 * they already have a shell there. The owner's agent answers the file as
 * base64 (`read-image` RPC), refusing anything that is not a raster image.
 */
export async function readImageFor(
  userId: string, projectId: string, workstream: unknown, imagePath: unknown,
): Promise<{ status: 200; mime: string; image: Buffer } | { status: number; body: unknown }> {
  if (typeof imagePath !== 'string' || imagePath === '') {
    return { status: 400, body: { error: 'path required' } };
  }
  if (imagePath.length > READ_IMAGE_MAX_PATH) return { status: 400, body: { error: 'path too long' } };
  if (!imagePath.startsWith('/') && !imagePath.startsWith('~/')) {
    return { status: 400, body: { error: 'path must be absolute' } };
  }
  let access;
  try {
    access = await assertSessionAccess(userId, projectId, 'agent', typeof workstream === 'string' && workstream ? workstream : 'main');
  } catch (err) {
    if (err instanceof SessionAccessError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
  if (!isProjectAgentConnected(access.host)) {
    return { status: 503, body: { error: "Owner's agent is offline" } };
  }
  // Hovering along a list of screenshots is fine; a flood of them is not.
  const inFlight = readImageInFlight.get(userId) ?? 0;
  if (inFlight >= READ_IMAGE_MAX_IN_FLIGHT) {
    return { status: 429, body: { error: `Rate limited (max ${READ_IMAGE_MAX_IN_FLIGHT} image reads at a time)` } };
  }
  readImageInFlight.set(userId, inFlight + 1);
  let r: { data?: unknown; mime?: unknown };
  try {
    r = await sendForProject(access.host, 'read-image', { path: imagePath }, READ_IMAGE_TIMEOUT_MS);
  } catch (err) {
    const message = (err as Error).message;
    // An agent from before the RPC (agent.js `default:` case).
    if (message.startsWith('Unknown command: read-image')) {
      return { status: 501, body: { error: 'This box needs an update to preview images' } };
    }
    if (/not an image|not a file/.test(message)) return { status: 415, body: { error: message } };
    if (/too large/.test(message)) return { status: 413, body: { error: message } };
    return { status: 503, body: { error: `read-image failed: ${message}` } };
  } finally {
    const left = (readImageInFlight.get(userId) ?? 1) - 1;
    if (left > 0) readImageInFlight.set(userId, left); else readImageInFlight.delete(userId);
  }
  if (r?.data === null) return { status: 404, body: { error: 'No such file' } };
  if (typeof r?.data !== 'string' || typeof r.mime !== 'string' || !READ_IMAGE_TYPES.has(r.mime)) {
    return { status: 502, body: { error: 'Unexpected answer from the box' } };
  }
  return { status: 200, mime: r.mime, image: Buffer.from(r.data, 'base64') };
}

/** Search pane text across the user's reachable sessions (search route, cookie or agent token). */
export async function searchFor(
  userId: string, query: Record<string, unknown>,
  /** Who is searching, for the rate-limit key (see captureFor). */
  callerId: string = 'browser',
  deps: SearchDeps = liveSearchDeps(id => listSessionRowsFor(id)),
  now: number = Date.now(),
): Promise<{ status: number; body: unknown }> {
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  if (q.length < SEARCH_MIN_QUERY) return { status: 400, body: { error: `q must be at least ${SEARCH_MIN_QUERY} characters` } };
  if (q.length > SEARCH_MAX_QUERY) return { status: 400, body: { error: `q too long (max ${SEARCH_MAX_QUERY} chars)` } };
  const requested = parseInt(query.lines as string, 10);
  const lines = Number.isFinite(requested) ? Math.max(1, Math.min(1000, requested)) : SEARCH_DEFAULT_LINES;
  const roles = parseRoles(query.roles);

  const cacheKey = `${userId}:${q.toLowerCase()}:${lines}:${roles.join(',')}`;
  const cached = searchCache.get(cacheKey);
  if (cached && now - cached.at < SEARCH_CACHE_MS) return { status: 200, body: { ...cached.result, cached: true } };

  const rateKey = `${userId}:${callerId}`;
  const previous = searchRateLimits.get(rateKey);
  if (now - (previous ?? 0) < SEARCH_MIN_INTERVAL_MS) {
    return { status: 429, body: { error: `Rate limited (one pane search per ${SEARCH_MIN_INTERVAL_MS / 1000}s per caller)` } };
  }
  // Stamped before the fan-out so concurrent requests cannot both run; a
  // search that fails outright hands the budget back.
  searchRateLimits.set(rateKey, now);
  let result: SearchResult;
  try {
    result = await searchSessions(userId, q, { lines, roles }, deps);
  } catch (err) {
    if (previous === undefined) searchRateLimits.delete(rateKey); else searchRateLimits.set(rateKey, previous);
    throw err;
  }
  for (const [k, v] of searchCache) if (now - v.at >= SEARCH_CACHE_MS) searchCache.delete(k);
  searchCache.set(cacheKey, { at: now, result });
  return { status: 200, body: result };
}
