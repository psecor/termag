// Phone-sized viewport → /m. Pure so the heuristic is
// unit-testable; the gate component in App.tsx feeds it the live values.

export const MOBILE_OPT_OUT_KEY = 'termag-mobile-opt-out';
export const MOBILE_MEDIA_QUERY = '(max-width: 767px) and (pointer: coarse)';

export interface RedirectInputs {
  /** Flag `mobile-redirect-enabled`; default off. */
  flagOn: boolean;
  /** `matchMedia(MOBILE_MEDIA_QUERY).matches` */
  phoneLike: boolean;
  /** The user pressed "Full UI" on this browser. */
  optedOut: boolean;
}

export function shouldRedirectToMobile(i: RedirectInputs): boolean {
  return i.flagOn && i.phoneLike && !i.optedOut;
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
