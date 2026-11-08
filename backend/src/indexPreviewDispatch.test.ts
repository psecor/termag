/**
 * index.ts mounts the preview host's dispatch first, and its upgrade handler
 * asks it first (SR3). The
 * order is the isolation: ahead of the request surface, CORS (which would
 * stamp termag's Allow-Origin on an app's answer), the body parsers (which
 * would eat a POST's body before the relay pipes it), the session and the
 * ALB bridge. #167 learnt this the hard way (#314). previewHost.test.ts pins
 * that the dispatch itself never calls next(); this pins where it sits.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function at(snippet: string): number {
  const i = code.indexOf(snippet);
  expect(i, `index.ts no longer has ${snippet}: update this check`).toBeGreaterThanOrEqual(0);
  return i;
}

describe('index.ts: the preview dispatch comes first', () => {
  it('is the first app.use, ahead of everything termag mounts', () => {
    const dispatch = at('app.use(previewHost.dispatch);');
    const firstUse = code.indexOf('app.use(');
    expect(firstUse).toBe(dispatch);
    for (const later of ['app.use(BASE_PATH || \'/\', surfaceMiddleware);', 'app.use(cors(', 'app.use(express.json());', 'app.use(BASE_PATH || \'/\', sessionMiddleware);', 'app.use(BASE_PATH || \'/\', albSessionBridge);']) {
      expect(dispatch, later).toBeLessThan(at(later));
    }
  });

  it('is the first thing the upgrade handler does', () => {
    const handler = at("server.on('upgrade', (req, socket, head) => {");
    const body = code.slice(handler);
    const firstStatement = body.split('\n').slice(1).map(l => l.trim()).find(Boolean);
    expect(firstStatement).toBe('if (previewHost.dispatchUpgrade(req, socket, head)) return;');
  });
});

describe('index.ts: an audience ended anywhere closes this process\'s preview sockets', () => {
  it('installs the link delivery with the relay\'s revoke hook (archive, workstream removal, the sweep)', () => {
    const install = at('installPreviewLinkDelivery({');
    const call = code.slice(install, code.indexOf(');', install));
    expect(call).toMatch(/onSessionsRevoked: \(linkId, idHashes\) => previewSessionsRevoked\(linkId, idHashes\)/);
    expect(at("onPreviewSessionsRevoked((linkId, idHashes) => previewHost.revoked(linkId, idHashes));")).toBeGreaterThan(0);
  });
});

describe('index.ts: a draining process lets go of its preview tunnels', () => {
  it('closes the preview sockets and the viewers\' HTTP pools when the browsers go', () => {
    const close = at('const closeSockets = (agents: boolean): number => {');
    const body = code.slice(close, code.indexOf('\n};', close));
    expect(body).toContain('previewHost.closeAll(RELAY_REDIAL_CLOSE_CODE, DRAIN_CLOSE_REASON);');
  });
});

describe('index.ts: the landing page comes after the confirm page', () => {
  it('mounts /previews/confirm ahead of /previews, so a confirm URL is never read as a link name', () => {
    expect(at('app.use(`${BASE_PATH}/previews/confirm`')).toBeLessThan(at('app.use(`${BASE_PATH}/previews`, previewLandingRouter('));
  });
});
