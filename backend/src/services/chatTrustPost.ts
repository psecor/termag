/**
 * Same-origin JSON gate for the chat's browser POSTs.
 *
 * termag.sid is SameSite=Lax, so a top-level form POST from another
 * https://*.example.com origin still carries it. express.json() ignores that
 * form body. POST /chat/trust used to trust the project anyway, and POST
 * /chat/terminal would then resume the main chat. Either one drops the
 * read-only closure.
 *
 * A browser cannot set Sec-Fetch-Site. Anything other than same-origin is
 * refused, including same-site. When that header is absent, Origin must be
 * on the cookie WebSocket allowlist (auth/wsOrigin.ts). A missing Origin is
 * not enough: these routes are the browser, not the agent.
 *
 * The body has to be JSON. Trust additionally requires `{ trust: true }`.
 * Terminal accepts any JSON object (`{ workstream }`); an empty form is not
 * a resume of main.
 */
import { allowedWsOrigins } from '../auth/wsOrigin';
import { isSameOriginPost } from './cliAuth';

export interface ChatTrustPost {
  secFetchSite?: string;
  origin?: string;
  contentType?: string;
  body: unknown;
}

function originRefusal(post: ChatTrustPost, env: NodeJS.ProcessEnv): { status: 403; error: string } | null {
  const allowed = [...allowedWsOrigins(env)];
  if (!isSameOriginPost({ secFetchSite: post.secFetchSite, origin: post.origin }, allowed)) {
    return { status: 403, error: '' };
  }
  return null;
}

function isJsonObject(post: ChatTrustPost): boolean {
  const media = post.contentType?.split(';')[0]?.trim().toLowerCase();
  if (media !== 'application/json') return false;
  const body = post.body;
  return Boolean(body) && typeof body === 'object' && !Array.isArray(body);
}

export function chatTrustPostRefusal(
  post: ChatTrustPost,
  env: NodeJS.ProcessEnv = process.env,
): { status: 400 | 403; error: string } | null {
  if (originRefusal(post, env)) return { status: 403, error: 'This trust request did not come from termag.' };
  if (!isJsonObject(post) || (post.body as { trust?: unknown }).trust !== true) {
    return { status: 400, error: 'Trust requires a JSON body.' };
  }
  return null;
}

/** The same same-origin JSON gate as trust, for POST /chat/terminal. Any JSON object; `{ trust: true }` is not required. */
export function chatTerminalPostRefusal(
  post: ChatTrustPost,
  env: NodeJS.ProcessEnv = process.env,
): { status: 400 | 403; error: string } | null {
  if (originRefusal(post, env)) return { status: 403, error: 'This resume request did not come from termag.' };
  if (!isJsonObject(post)) return { status: 400, error: 'Resume requires a JSON body.' };
  return null;
}

/** POST /chat/reclaim. A form POST must not exit the pane's Claude or send a message. */
export function chatReclaimPostRefusal(
  post: ChatTrustPost,
  env: NodeJS.ProcessEnv = process.env,
): { status: 400 | 403; error: string } | null {
  if (originRefusal(post, env)) return { status: 403, error: 'This request did not come from termag.' };
  if (!isJsonObject(post)) return { status: 400, error: 'Returning the chat requires a JSON body.' };
  return null;
}

/**
 * A refused browser POST is the response. The handler — chatTerminalFor,
 * chatTrustFor — runs only when the gate passed, so a form POST never
 * resumes or trusts.
 */
export async function runAfterPostRefusal<T extends { status: number; body: unknown }>(
  refusal: { status: number; error: string } | null,
  handler: () => Promise<T>,
): Promise<T | { status: number; body: { error: string } }> {
  if (refusal) return { status: refusal.status, body: { error: refusal.error } };
  return handler();
}
