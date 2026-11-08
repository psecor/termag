import { useEffect, useState } from 'react';
import { environmentsApi, type EnvironmentView } from '../services/api';
import { FLAGS, useFlag } from '../flags';

/** The last list this tab read, so a picker opened again renders with it on its first frame. */
let lastList: EnvironmentView[] | null = null;
const NONE: EnvironmentView[] = [];

/**
 * Whether the UI offers environments at all: environment-selection-enabled, a
 * kill switch that falls back on. Off, the pickers, the Environments links and
 * the Environments pages are hidden; the API and the CLI are not behind it.
 */
export function useEnvironmentSelection(): boolean {
  return useFlag(FLAGS.environmentSelection, true);
}

/**
 * Every environment, for the create dialogs' pickers:
 * read while `active`, and empty while not (an automation's form offers none),
 * or while environment selection is off (useEnvironmentSelection), so no picker
 * is offered and New session's ?environment= names none.
 * Until it answers, the last list this tab read, with `seed` (the environment an
 * environment's page opened New session with) in place of its row, which may
 * predate a rename, so nothing pops in on the first frame; empty after a failure
 * with neither, and the picker just isn't offered.
 */
export function useEnvironments(wanted = true, seed?: EnvironmentView | null): EnvironmentView[] {
  const active = useEnvironmentSelection() && wanted;
  const [list, setList] = useState<EnvironmentView[]>(() => {
    const base = lastList ?? [];
    return seed ? [...base.filter(e => e.id !== seed.id), seed] : base;
  });
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    environmentsApi.list().then(l => { lastList = l; if (!cancelled) setList(l); }).catch(() => {});
    return () => { cancelled = true; };
  }, [active]);
  return active ? list : NONE;
}

/** For tests: forget the last list. */
export function resetEnvironmentsForTests(): void { lastList = null; }
