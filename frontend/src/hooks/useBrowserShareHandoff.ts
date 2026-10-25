import { useCallback, useEffect, useRef, useState } from 'react';
import { browserHandoff, type BrowserShareHandoff } from '../utils/browserPaneConnection';

/**
 * A share link's handoff to its owner's own pane:
 * `?browser=open&browserShare=<id>[&browserAt=<path>]`, read once from the
 * URL the workspace loaded with. On the first render that has a project it
 * opens that project's browser dock, brings the ctrl tab forward on a narrow
 * viewport (the dock lives in that column), and drops the parameters from the
 * URL. `openShare` is for the dock's first dial only: the pane calls
 * `consumeOpenShare` once a dial carrying it is ready, so a later reopen of
 * the dock lands where the owner left off, not back on the shared page.
 */
export function useBrowserShareHandoff(opts: {
  browserKey: string;
  isNarrow: boolean;
  expandDock: (browserKey: string) => void;
  showCtrl: () => void;
}): { openShare: BrowserShareHandoff | null; consumeOpenShare: () => void } {
  const { browserKey, isNarrow, expandDock, showCtrl } = opts;
  const [handoff] = useState(() => browserHandoff(window.location.search));
  const [openShare, setOpenShare] = useState<BrowserShareHandoff | null>(handoff?.share ?? null);
  const handedOff = useRef(false);
  useEffect(() => {
    if (!handoff || handedOff.current || !browserKey) return;
    handedOff.current = true;
    expandDock(browserKey);
    if (isNarrow) showCtrl();
    const sp = new URLSearchParams(window.location.search);
    sp.delete('browser');
    sp.delete('browserShare');
    sp.delete('browserAt');
    const q = sp.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
  }, [handoff, browserKey, isNarrow, expandDock, showCtrl]);
  const consumeOpenShare = useCallback(() => setOpenShare(null), []);
  return { openShare, consumeOpenShare };
}
