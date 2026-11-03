// One automation's detail and run history for its simple-UI page
// (pages/chat/automations/AutomationDetail.tsx), polled every 10 s while
// the tab is visible. Two rules keep a stale answer off the page:
// - an answer is applied only if it is the newest request for the id on
//   screen now, so a slow fetch never overwrites a newer one;
// - a reload asked for another id (a Run now on the automation the page
//   showed before the URL changed) does nothing.
// A failed load keeps the last detail and reports the error beside it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { automationsApi, type AutomationRunView, type AutomationView } from '../services/api';
import { AUTOMATIONS_POLL_MS } from './useAutomations';
import { errorText } from './automationsView';

export type AutomationDetailView = AutomationView & { runs: AutomationRunView[] };

interface State { id: string; detail: AutomationDetailView | null; error: string | null }

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export function useAutomation(id: string, enabled: boolean): {
  detail: AutomationDetailView | null;
  error: string | null;
  /** Reloads this id's detail; a call made for an id no longer on screen does nothing. */
  reload: () => Promise<void>;
} {
  const [state, setState] = useState<State>({ id, detail: null, error: null });
  const idRef = useRef(id);
  idRef.current = id;
  const token = useRef(0);

  const reload = useCallback(async () => {
    const forId = id;
    if (forId !== idRef.current) return;
    const mine = ++token.current;
    const current = () => mine === token.current && forId === idRef.current;
    try {
      const detail = await automationsApi.get(forId);
      if (!current()) return;
      setState({ id: forId, detail, error: null });
    } catch (err) {
      if (!current()) return;
      const error = errorText(err, 'Could not load this automation');
      setState(s => (s.id === forId ? { ...s, error } : { id: forId, detail: null, error }));
    }
  }, [id]);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    const t = setInterval(() => { if (visible()) void reload(); }, AUTOMATIONS_POLL_MS);
    const onVisible = () => { if (visible()) void reload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      token.current++; // an answer in flight for the id the page is leaving is dropped
    };
  }, [enabled, reload]);

  const mine = state.id === id;
  return { detail: mine ? state.detail : null, error: mine ? state.error : null, reload };
}
