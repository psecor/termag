// Phone-sized viewport → /m, or under chat-phone-home-enabled the chat
// (§5.1). Pure so the heuristic is unit-testable; the gate
// component in App.tsx feeds it the live values.
import { LAB_PARAM, withoutLoginParams } from '../chat/uiMode';

export const MOBILE_OPT_OUT_KEY = 'termag-mobile-opt-out';
export const MOBILE_MEDIA_QUERY = '(max-width: 767px) and (pointer: coarse)';
/** A touch device: an installed app there is the phone client (§5.1). */
export const TOUCH_MEDIA_QUERY = '(pointer: coarse)';

export interface RedirectInputs {
  /** `matchMedia(MOBILE_MEDIA_QUERY).matches` */
  phoneLike: boolean;
  /** The user pressed "Lab" on this browser (or, installed, in this window). */
  optedOut: boolean;
  /** Launched from the home screen on a touch device (`installedOnTouch`). */
  installed?: boolean;
}

/**
 * Installed on a phone or tablet, the app is the phone client whatever the
 * viewport: sign-in returns to `/termag/` with no way back otherwise.
 */
export function shouldRedirectToMobile(i: RedirectInputs): boolean {
  if (i.optedOut) return false;
  if (i.installed) return true;
  return i.phoneLike;
}

type MatchMediaFn = (query: string) => { matches: boolean };
interface DisplayEnv {
  matchMedia?: MatchMediaFn;
  /** iOS Safari's non-standard `navigator.standalone`; `object` so a real Navigator fits. */
  navigator?: object;
}

/** Running in a home-screen window (Android/desktop display-mode, or iOS's `navigator.standalone`). */
export function isStandalone(env: DisplayEnv | undefined): boolean {
  if (!env) return false;
  try {
    if ((env.navigator as { standalone?: boolean } | undefined)?.standalone === true) return true;
    const mm = env.matchMedia;
    if (!mm) return false;
    return mm('(display-mode: standalone)').matches || mm('(display-mode: fullscreen)').matches;
  } catch {
    return false;
  }
}

/**
 * Installed on a touch device. A desktop install (Chrome's install button)
 * keeps the workspace: it has a mouse and the full UI fits.
 */
export function installedOnTouch(env: DisplayEnv | undefined): boolean {
  if (!isStandalone(env)) return false;
  try { return !!env?.matchMedia?.(TOUCH_MEDIA_QUERY).matches; } catch { return false; }
}

/** An installed app that gets the installed-app rules (§5.1): `installedOnTouch`. */
export function installedAppMode(env: DisplayEnv | undefined): boolean {
  return installedOnTouch(env);
}

/** Carries a workspace deep link (`?project=…&ws=…`) over to its /m route. */
export function mobileHrefFromWorkspaceSearch(search: string): string {
  const sp = new URLSearchParams(search);
  const project = sp.get('project');
  if (!project) return '/m';
  const ws = sp.get('ws');
  return `/m/p/${encodeURIComponent(project)}${ws && ws !== 'main' ? `?ws=${encodeURIComponent(ws)}` : ''}`;
}

/**
 * The session a workspace link names for a phone landing in the chat: a Lab
 * link to a project's session (`?project=<id>[&ws=<name>]`, Slack's and the
 * automation reports' links) with nothing the chat has no equivalent for.
 * Null for the bare workspace URL, a link marked as opening Lab on purpose
 * (LAB_PARAM), or one with any other parameter (`branchOff`, a share
 * handoff), which keep today's /m route.
 */
export function phoneChatSession(search: string): { projectId: string; workstream: string } | null {
  const sp = new URLSearchParams(withoutLoginParams(search));
  const project = sp.get('project');
  if (!project) return null;
  if ([...sp.keys()].some(key => key !== 'project' && key !== 'ws')) return null;
  return { projectId: project, workstream: sp.get('ws') || 'main' };
}

/**
 * Where a phone sent off the workspace URL lands (shouldRedirectToMobile).
 * With `phoneChat` (chat-phone-home-enabled, for a page loaded here): the
 * bare workspace URL opens the chat, `/chat`, and a link to a session that
 * session's chat (`/chat/p/<id>[?ws=<name>]`, chatHref) when `hasChat` says
 * the project list shows it has one (chat/simpleChat.ts sessionHasChat).
 * Anything else, the flag off included, is today's /m route
 * (mobileHrefFromWorkspaceSearch): a link with a parameter the chat has no
 * equivalent for (Lab's `?prs=<view>`, say) isn't the chat's to open.
 */
export function phoneLandingHref(i: { search: string; phoneChat: boolean; hasChat: boolean }): string {
  const mobile = mobileHrefFromWorkspaceSearch(i.search);
  if (!i.phoneChat) return mobile;
  const sp = new URLSearchParams(withoutLoginParams(i.search));
  if (sp.has(LAB_PARAM)) return mobile;
  if (!sp.get('project')) return [...sp.keys()].length === 0 ? '/chat' : mobile;
  const session = phoneChatSession(i.search);
  if (!session || !i.hasChat) return mobile;
  const base = `/chat/p/${encodeURIComponent(session.projectId)}`;
  return session.workstream === 'main' ? base : `${base}?ws=${encodeURIComponent(session.workstream)}`;
}

export function readOptOut(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
  try { return storage?.getItem(MOBILE_OPT_OUT_KEY) === '1'; } catch { return false; }
}

export function writeOptOut(storage: Pick<Storage, 'setItem' | 'removeItem'> | null | undefined, optOut: boolean): void {
  try {
    if (optOut) storage?.setItem(MOBILE_OPT_OUT_KEY, '1');
    else storage?.removeItem(MOBILE_OPT_OUT_KEY);
  } catch { /* private mode */ }
}

function safeStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try { return typeof window !== 'undefined' ? window[kind] : null; } catch { return null; }
}

/**
 * Where "Lab" is remembered: this browser for good, or — in an installed
 * app — this window only, so the next launch is the phone client again.
 */
export function optOutStorage(installed: boolean): Storage | null {
  return safeStorage(installed ? 'sessionStorage' : 'localStorage');
}

/** The live "has this browser/window pressed Lab" answer. */
export function currentOptOut(installed: boolean): boolean {
  return readOptOut(optOutStorage(installed));
}

/** "Lab": stop redirecting this browser (or this installed window). */
export function optOutOfMobile(): void {
  const installed = typeof window !== 'undefined' && installedAppMode(window);
  writeOptOut(optOutStorage(installed), true);
}

/** "Phone view": clear both opt-outs so the redirect works again. */
export function optBackIntoMobile(): void {
  writeOptOut(safeStorage('localStorage'), false);
  writeOptOut(safeStorage('sessionStorage'), false);
}

/** iPhone, iPod, or an iPad (which may claim to be a Mac). */
export function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return true;
  return /\bMacintosh\b/.test(userAgent) && maxTouchPoints > 1;
}
