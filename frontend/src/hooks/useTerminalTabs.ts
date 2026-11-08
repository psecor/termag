import { useCallback, useEffect, useRef, useState } from 'react';
import { terminalApi, type TerminalSlotInfo } from '../services/api';

/**
 * Terminal slots: the workspace's terminal tab list —
 * the ctrl pane (slot 1, always the first tab) plus the shells the user adds
 * with + and closes with ✕. The truth is what tmux says, via GET …/terminals,
 * re-read when the project or workstream changes; adds and closes update the
 * list optimistically and fall back to a re-read when they fail. The active
 * tab resets to ctrl on a switch, every answer for a stale project+workstream
 * is dropped, and so is a fetch that started before the mutation it would
 * clobber.
 */
export function useTerminalTabs({ projectId, workstream, enabled }: {
  projectId: string | null;
  workstream: string;
  /** terminal-tabs-enabled for the user: off, the tab list does not exist. */
  enabled: boolean;
}) {
  const key = projectId ? `${projectId}/${workstream}` : '';
  const [tabs, setTabs] = useState<TerminalSlotInfo[]>([]);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const keyRef = useRef(key);
  keyRef.current = key;
  // Bumped by every mutation; a fetch that started before it captures the
  // value and its answer is dropped, so a slow list can never overwrite what
  // the user just did.
  const epochRef = useRef(0);

  useEffect(() => {
    // Clear at once: the old workstream's tabs must not linger under the new
    // key, where a click on one would act on the new workstream's slot number
    // (a ✕ would kill the wrong pane, an attach would create one there).
    setTabs([]);
    setActiveSlot(null);
    setError(null);
    if (!enabled || !projectId) return;
    let stale = false;
    const epoch = epochRef.current;
    terminalApi.list(projectId, workstream)
      .then(r => { if (!stale && epochRef.current === epoch) setTabs(r.terminals.filter(t => t.slot >= 2)); })
      .catch(() => { /* keep what we have: offline is unknown, not "no tabs" */ });
    return () => { stale = true; };
  }, [projectId, workstream, enabled]);

  // A re-read that lost the active tab (its pane died while offline) falls
  // back to the ctrl pane rather than showing a terminal with no tab on it.
  const adopt = useCallback((next: TerminalSlotInfo[]) => {
    setTabs(next);
    setActiveSlot(cur => (cur !== null && next.some(t => t.slot === cur) ? cur : null));
  }, []);

  /** The list from tmux, once more — after a mutation, to reconcile the strip with the truth. */
  const refresh = useCallback(async () => {
    if (!projectId) return;
    const at = keyRef.current;
    const epoch = epochRef.current;
    try {
      const r = await terminalApi.list(projectId, workstream);
      if (keyRef.current !== at || epochRef.current !== epoch) return;
      adopt(r.terminals.filter(t => t.slot >= 2));
    } catch { /* keep what we have — the optimistic state is the best answer */ }
  }, [projectId, workstream, adopt]);


  const add = useCallback(async () => {
    if (!projectId) return;
    const at = keyRef.current;
    setError(null);
    setAdding(true);
    epochRef.current++;
    try {
      const r = await terminalApi.add(projectId, workstream);
      if (keyRef.current !== at) return;
      setTabs(prev => prev.some(t => t.slot === r.slot)
        ? prev
        : [...prev, { session: r.session, slot: r.slot, label: r.label }].sort((a, b) => a.slot - b.slot));
      setActiveSlot(r.slot);
      // Reconcile with tmux: the mount fetch may still be in flight (its
      // answer died with the epoch bump), and the strip must show the tabs
      // that were already open, not just the new one.
      await refresh();
    } catch (err: any) {
      if (keyRef.current === at) setError(err?.response?.data?.error ?? 'Could not add a terminal');
    } finally {
      setAdding(false);
    }
  }, [projectId, workstream, refresh]);

  const close = useCallback(async (slot: number) => {
    if (!projectId) return;
    const at = keyRef.current;
    setError(null);
    epochRef.current++;
    setTabs(prev => prev.filter(t => t.slot !== slot));
    setActiveSlot(cur => (cur === slot ? null : cur));
    try {
      await terminalApi.close(projectId, workstream, slot);
    } catch (err: any) {
      if (keyRef.current !== at) return;
      setError(err?.response?.data?.error ?? 'Could not close the terminal');
      // The pane may still be alive (an offline agent answered 503): the list
      // is what tmux says, so read it back rather than guess.
      await refresh();
    }
  }, [projectId, workstream, refresh]);

  return { tabs, activeSlot, setActiveSlot, add, close, error, clearError: useCallback(() => setError(null), []), adding };
}
