// Phone-sized viewport → /m. Pure so the heuristic
// is unit-testable; the gate component in App.tsx feeds it the live values.

export const MOBILE_OPT_OUT_KEY = 'termag-mobile-opt-out';
export const MOBILE_MEDIA_QUERY = '(max-width: 767px) and (pointer: coarse)';
/** A touch device: an installed app there is the phone client (§5.1). */
export const TOUCH_MEDIA_QUERY = '(pointer: coarse)';

export interface RedirectInputs {
  /** Flag `mobile-redirect-enabled`; default off. */
  flagOn: boolean;
  /** `matchMedia(MOBILE_MEDIA_QUERY).matches` */
  phoneLike: boolean;
  /** The user pressed "Full UI" on this browser (or, installed, in this window). */
  optedOut: boolean;
  /** Launched from the home screen on a touch device (`installedOnTouch`). */
  installed?: boolean;
}

/**
 * Installed on a phone or tablet, the app is the phone client whatever the
 * flag says: installing it is the opt-in the flag stands in for, and sign-in
 * returns to `/termag/` with no way back otherwise.
 */
export function shouldRedirectToMobile(i: RedirectInputs): boolean {
  if (i.optedOut) return false;
  if (i.installed) return true;
  return i.flagOn && i.phoneLike;
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

// mobile-installed-app-enabled (flags.ts). Kept here, set by the components that
// read flags (MobileRedirectGate, MobileApp), because the opt-out helpers below
// run from click handlers all over /m that don't.
let installedAppEnabled = false;
export function setInstalledAppEnabled(on: boolean): void {
  installedAppEnabled = on;
}

/** An installed app that gets the installed-app rules (§5.1): the flag is on and `installedOnTouch`. */
export function installedAppMode(env: DisplayEnv | undefined): boolean {
  return installedAppEnabled && installedOnTouch(env);
}

/** Carries a workspace deep link (`?project=…&ws=…`) over to its /m route. */
export function mobileHrefFromWorkspaceSearch(search: string): string {
  const sp = new URLSearchParams(search);
  const project = sp.get('project');
  if (!project) return '/m';
  const ws = sp.get('ws');
  return `/m/p/${encodeURIComponent(project)}${ws && ws !== 'main' ? `?ws=${encodeURIComponent(ws)}` : ''}`;
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
 * Where "Full UI" is remembered: this browser for good, or — in an installed
 * app — this window only, so the next launch is the phone client again.
 */
export function optOutStorage(installed: boolean): Storage | null {
  return safeStorage(installed ? 'sessionStorage' : 'localStorage');
}

/** The live "has this browser/window pressed Full UI" answer. */
export function currentOptOut(installed: boolean): boolean {
  return readOptOut(optOutStorage(installed));
}

/** "Full UI": stop redirecting this browser (or this installed window). */
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
