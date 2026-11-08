/**
 * The preview host and the landing page as index.ts mounts them: the prisma
 * store, the flags, ALLOWED_USERS, the box registry and the environment
 * (PREVIEW_LINKS_DOMAIN, PREVIEW_LINKS_COOKIE_SECRET). Kept out of
 * previewHost.ts so its tests never load the database or the registry.
 */
import type { WebSocket, WebSocketServer } from 'ws';
import { parseAllowedUsers, resolveUnixUsername } from '../auth/allowedUsers';
import { isInstanceAgentConnected, projectAgentCapabilities } from './agentRegistry';
import { instanceStatus } from './boxPower';
import { notePreviewViewerActivity } from './previewLinkActivity';
import { previewLinksEnabled, previewLinksKilled } from './previewLinkFlags';
import { createPreviewHost, type PreviewHost, type PreviewHostDeps } from './previewHost';
import { normalisePreviewDomain } from './previewHostGrammar';
import { cookieSecretFrom } from './previewHostRules';
import { prismaPreviewHostStore, type HostLinkContext } from './previewHostStore';
import type { PreviewTunnels } from './previewRelay';
import { projectDirUnder, resolveProjectRoot } from './projectPaths';
import type { PreviewLandingDeps } from '../routes/previewLanding';

/** The workstream checkout a link was made for, as the box lays it out. */
export function checkoutDirOf(ctx: HostLinkContext): string {
  const root = resolveProjectRoot({ ownerUnixUser: ctx.project.owner.unixUsername, hostHome: ctx.project.instance?.hostHome });
  return projectDirUnder(root, ctx.project.name, ctx.workstreamName);
}

// Normalised as classifyHost and isPreviewOrigin read it, so the hand-off URL and the Origin checks agree with dispatch.
export const domainFromEnv = () => normalisePreviewDomain(process.env.PREVIEW_LINKS_DOMAIN);
let warnedSecret = false;
const secretFromEnv = () => {
  const key = cookieSecretFrom(process.env.PREVIEW_LINKS_COOKIE_SECRET);
  if (!key && domainFromEnv() && !warnedSecret) {
    warnedSecret = true;
    console.error('[PREVIEW-LINK] PREVIEW_LINKS_DOMAIN is set but PREVIEW_LINKS_COOKIE_SECRET is not 32+ bytes of base64: preview hosts answer 404');
  }
  return key;
};

export const previewHostEnvDeps: Pick<PreviewHostDeps, 'store' | 'domain' | 'cookieSecret' | 'flags' | 'allowed' | 'box' | 'checkoutDir' | 'noteActivity'> = {
  store: prismaPreviewHostStore,
  domain: domainFromEnv,
  cookieSecret: secretFromEnv,
  flags: async (owner, box) => {
    const [enabled, killSwitch] = await Promise.all([previewLinksEnabled(owner, box), previewLinksKilled(owner, box)]);
    return { enabled, killSwitch };
  },
  allowed: (email) => resolveUnixUsername(parseAllowedUsers(process.env.ALLOWED_USERS), email) !== undefined,
  box: {
    status: (boxId) => instanceStatus(boxId),
    connected: (boxId) => isInstanceAgentConnected(boxId),
    capabilities: (boxId) => projectAgentCapabilities({ userId: '', instanceId: boxId }),
  },
  checkoutDir: checkoutDirOf,
  // A viewer's input keeps the owner's box awake, as a preview share's guest's does (PR 1's rule).
  noteActivity: (boxId, headers) => { notePreviewViewerActivity(boxId, headers); },
};

export function previewHostFromEnv(opts: {
  tunnels: PreviewTunnels;
  siteBase: string;
  isServing: () => boolean;
  wss: WebSocketServer;
  heartbeat?: (ws: WebSocket) => void;
}): PreviewHost {
  return createPreviewHost({ ...previewHostEnvDeps, tunnels: opts.tunnels, siteBase: () => opts.siteBase, isServing: opts.isServing, wss: opts.wss, heartbeat: opts.heartbeat });
}

export function previewLandingFromEnv(opts: Pick<PreviewLandingDeps, 'user' | 'signIn' | 'signInFresh'>): PreviewLandingDeps {
  const { store, domain, cookieSecret, flags, allowed } = previewHostEnvDeps;
  return { store, domain, cookieSecret, flags, allowed, boxStatus: (boxId) => instanceStatus(boxId), ...opts };
}
