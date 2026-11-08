import { useCallback, useEffect, useRef, useState } from 'react';
import { browserHandoff, handoffBrowserKey, type BrowserShareHandoff } from '../utils/browserPaneConnection';
import { rememberBrowserUrl } from '../components/BrowserDock';

/**
 * A share link's handoff to its owner's own pane:
 * `?browser=open&browserShare=<id>[&browserAt=<path>]`, read once from the
 * URL the workspace (or the simple UI, chat/uiMode.ts simpleUiShareHandoff)
 * loaded with. On the first render that has a project it opens that
 * project's browser (the workspace's dock, the simple UI's side panel on
 * Browser), brings it forward on a narrow viewport (the workspace's ctrl tab,
 * the simple UI's overlay), and drops the parameters from the URL. `openShare` is for the dock's first dial only: the pane calls
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
  const [handoff] = useState(() => {
    const h = browserHandoff(window.location.search);
    // `browserUrl` (an environment's port link, browserPortHref): the page the pane opens, written
    // where the pane reads its last URL before any pane has mounted, in this first render.
    const key = h?.url ? handoffBrowserKey(window.location.pathname, window.location.search) : null;
    if (h?.url && key) rememberBrowserUrl(key, h.url);
    return h;
  });
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
    sp.delete('browserUrl');
    const q = sp.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
  }, [handoff, browserKey, isNarrow, expandDock, showCtrl]);
  const consumeOpenShare = useCallback(() => setOpenShare(null), []);
  return { openShare, consumeOpenShare };
}
