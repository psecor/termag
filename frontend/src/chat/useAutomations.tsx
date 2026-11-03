// The user's automations for the simple UI (behind
// simple-ui-automations-enabled and automations-enabled): one list, polled
// every 10 s while the tab is visible and again when it comes back, provided
// by AutomationsProvider in ChatApp so the sidebar's Automations button and
// the pages under /chat/automations share one poll. `reload` after a change
// (Run now, Pause, Archive) refreshes it without waiting for the poll.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { automationsApi, type AutomationView } from '../services/api';
import { FLAGS, useFlag } from '../flags';
import { errorText } from './automationsView';

export const AUTOMATIONS_POLL_MS = 10_000;

export interface AutomationsState {
  /** Both flags on: the button, the routes and the poll exist. */
  enabled: boolean;
  /** Null until the first answer. */
  list: AutomationView[] | null;
  /** The last load's failure; the list keeps its last answer. */
  error: string | null;
  reload: () => Promise<void>;
}

const AutomationsContext = createContext<AutomationsState>({ enabled: false, list: null, error: null, reload: async () => {} });

export function useAutomationsEnabled(): boolean {
  const simple = useFlag(FLAGS.simpleUiAutomations, false);
  const automations = useFlag(FLAGS.automations, false);
  return simple && automations;
}

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export function AutomationsProvider({ children }: { children: React.ReactNode }) {
  const enabled = useAutomationsEnabled();
  const [list, setList] = useState<AutomationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Newer loads win: a slow answer that lands after a newer one is dropped.
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const l = await automationsApi.list();
      if (mine !== seq.current) return;
      setList(l);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(errorText(err, 'Could not load automations'));
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void reload();
    const t = setInterval(() => { if (visible()) void reload(); }, AUTOMATIONS_POLL_MS);
    const onVisible = () => { if (visible()) void reload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      seq.current++; // an answer in flight when the flag went off is dropped
    };
  }, [enabled, reload]);
  const value = useMemo(() => ({ enabled, list: enabled ? list : null, error: enabled ? error : null, reload }), [enabled, list, error, reload]);
  return <AutomationsContext.Provider value={value}>{children}</AutomationsContext.Provider>;
}

export function useAutomations(): AutomationsState {
  return useContext(AutomationsContext);
}
