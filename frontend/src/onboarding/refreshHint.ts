// What this browser last saw of onboarding-refresh-enabled for a signed-in
// user. The sign-in page runs before
// anyone is signed in, so there is no user to evaluate the flag for;
// it shows the redrawn sign-in when the last person signed in here had it.
// Someone who has never signed in on this browser sees the sign-in on main
// until the flag is removed.

export const REFRESH_HINT_KEY = 'termag-onboarding-refresh';

type ReadStorage = Pick<Storage, 'getItem'> | null;
type WriteStorage = Pick<Storage, 'setItem' | 'removeItem'> | null;

function local(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export function readRefreshHint(storage: ReadStorage = local()): boolean {
  try { return storage?.getItem(REFRESH_HINT_KEY) === '1'; } catch { return false; }
}

export function writeRefreshHint(on: boolean, storage: WriteStorage = local()): void {
  try {
    if (on) storage?.setItem(REFRESH_HINT_KEY, '1');
    else storage?.removeItem(REFRESH_HINT_KEY);
  } catch { /* private mode: the sign-in stays the one on main */ }
}
