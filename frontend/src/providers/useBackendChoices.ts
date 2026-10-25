import { useEffect, useState } from 'react';
import { providersApi, type BackendChoice } from '../services/api';

export type { BackendChoice, ModelChoice } from '../services/api';

// One fetch per page: the menus are the orchestrator's configuration and the
// viewer's flags, which do not change while it is open. A failed fetch offers
// the defaults only, and is tried again next time.
let menus: Promise<Record<string, BackendChoice[]>> | null = null;
function loadMenus(): Promise<Record<string, BackendChoice[]>> {
  menus ??= Promise.resolve().then(() => providersApi.models()).then(r => r.providers ?? {}, () => { menus = null; return {}; });
  return menus;
}

/** For tests: forget the fetched menus. */
export function resetBackendChoicesForTests(): void { menus = null; }

const DEFAULT_ONLY: BackendChoice[] = [{ id: null, label: 'Default', models: [] }];

/**
 * The model backends a picker offers for this harness, each with its models:
 * the default first. One entry with no models means
 * there is nothing to choose, and the picker hides both fields.
 */
export function useBackendChoices(provider: string | null | undefined): BackendChoice[] {
  const [all, setAll] = useState<Record<string, BackendChoice[]> | null>(null);
  useEffect(() => {
    let live = true;
    void loadMenus().then(m => { if (live) setAll(m); });
    return () => { live = false; };
  }, []);
  return (provider && all?.[provider]) || DEFAULT_ONLY;
}
