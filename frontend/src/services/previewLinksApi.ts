/**
 * Client for preview links:
 * a box port published at its own address, opened in the viewer's own
 * browser. The routes are backend/src/routes/previewLinks.ts, all
 * session-authenticated; the JSON views are services/previewLinks.ts'
 * `linkView`, `requestView` and `ListenerView`. Every route answers 404 while
 * `preview-links-enabled` is off for the project's owner and box: the UI only
 * hides, the server decides.
 */
import axios from 'axios';
import { sendClientHeader } from '../buildInfo';

const api = axios.create({ baseURL: '/termag', withCredentials: true });
sendClientHeader(api);

export type PreviewLinkAudience = 'owner' | 'people' | 'link';
export type PreviewLinkHostMode = 'localhost' | 'public';

/** A listening port on the box, with port-guard's verdict (a refused one can't be published). */
export interface PreviewListener {
  port: number;
  pid: number | null;
  command: string | null;
  verdict: { ok: true } | { ok: false; code: string; reason: string };
  /** The process runs from the workstream's checkout. */
  inCheckout: boolean;
}

export interface PreviewLinkPerson { id: string; email: string; displayName: string }
export interface PreviewLinkGrantee extends PreviewLinkPerson { expiresAt: string | null }
/** Someone who opened the link; `revokedAt` once they were removed. */
export interface PreviewLinkViewer extends PreviewLinkPerson { firstOpenedAt: string; lastOpenedAt: string; revokedAt: string | null }

export interface PreviewLinkView {
  id: string;
  name: string;
  projectId: string;
  /** In the list's views only. */
  workstream?: string;
  port: number;
  audience: PreviewLinkAudience;
  hostMode: PreviewLinkHostMode;
  live: boolean;
  expiresAt: string;
  /** The latest an extend or a renew can take it: 30 days from its first publish. */
  maxExpiresAt: string;
  endedAt: string | null;
  endReason: string | null;
  createdAt: string;
  /** The landing URL without a token: what a person or a named viewer opens. */
  url: string;
  /** The app's own address, as the server names it (never built here from the name). Null while previews have no domain. */
  host: string | null;
  owner?: PreviewLinkPerson;
  grantees?: PreviewLinkGrantee[];
  viewers?: PreviewLinkViewer[];
}

/** An agent's ask to publish a port (`termag preview request`). Its note is the agent's words: untrusted. */
export interface PreviewLinkRequestView { id: string; workstreamId: string | null; port: number; note: string | null; state: string; createdAt: string }

export interface PreviewLinksList {
  links: PreviewLinkView[];
  requests: PreviewLinkRequestView[];
  ttlHoursDefault: number;
  previewDomain: string | null;
}

export interface PublishPreviewLinkBody {
  workstream: string;
  port: number;
  name: string;
  audience: PreviewLinkAudience;
  emails?: string[];
  ttlHours?: number;
  hostMode?: PreviewLinkHostMode;
  requestId?: string;
}

/**
 * A publish's answer. `shareUrl` carries a link audience's token, this once;
 * it's null for a renew that kept the token (`note` says so).
 */
export interface PublishedPreviewLink { link: PreviewLinkView; renewed: boolean; shareUrl: string | null; note?: string }

export const previewLinksApi = {
  list: (projectId: string): Promise<PreviewLinksList> =>
    api.get(`/api/projects/${projectId}/preview-links`).then(r => r.data),
  listeners: (projectId: string, workstream: string): Promise<PreviewListener[]> =>
    api.get(`/api/projects/${projectId}/preview-links/listeners`, { params: { workstream } }).then(r => r.data.listeners),
  publish: (projectId: string, body: PublishPreviewLinkBody): Promise<PublishedPreviewLink> =>
    api.post(`/api/projects/${projectId}/preview-links`, body).then(r => r.data),
  extend: (linkId: string, ttlHours: number): Promise<{ link: PreviewLinkView }> =>
    api.post(`/api/preview-links/${linkId}/extend`, { ttlHours }).then(r => r.data),
  revoke: (linkId: string) =>
    api.delete(`/api/preview-links/${linkId}`).then(r => r.data),
  removeViewer: (linkId: string, userId: string) =>
    api.delete(`/api/preview-links/${linkId}/viewers/${userId}`).then(r => r.data),
  declineRequest: (requestId: string) =>
    api.post(`/api/preview-link-requests/${requestId}/decline`).then(r => r.data),
};

/** The server's words for a refusal (`{ error, code }`), or a plain fallback. */
export function previewLinkError(err: unknown): string {
  const data = (err as { response?: { data?: { error?: unknown } } })?.response?.data;
  if (typeof data?.error === 'string' && data.error) return data.error;
  return err instanceof Error && err.message ? err.message : 'Something went wrong.';
}
