import React, { useCallback, useState } from 'react';
import { BrowserPane } from './BrowserPane';
import { safeAtPath, type BrowserShareHandoff } from '../utils/browserPaneConnection';

interface Props {
  projectId: string;
  workstream: string;
  expanded: boolean;
  onToggle: () => void;
  /** The owner's share link (`browserShare`, `browserAt`): the pane opens that share's app at its path. */
  openShare?: BrowserShareHandoff | null;
  /** The pane's dial carrying `openShare` is ready: the handoff is spent. */
  onOpenShareUsed?: () => void;
  /** browser-pane-persistent-profiles-enabled: the pane offers "Reset browser". */
  showReset?: boolean;
  /**
   * browser-pane-preview-share-enabled, owner only: "Share…" on the bar,
   * given the page the pane shows, for a link that
   * opens there.
   */
  onShare?: (atPath: string | null) => void;
}

const storageKey = (projectId: string, workstream: string) => `termag.browserPane.url.${projectId}/${workstream}`;

function readUrl(key: string): string {
  try { return window.localStorage.getItem(key) ?? ''; } catch { return ''; }
}

/** The page a loopback URL shows, as a share link's `at`; null for the app's root or anything else. */
export function sharePagePath(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!/^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(u.hostname)) return null;
  const at = `${u.pathname}${u.search}${u.hash}`;
  return at === '/' ? null : safeAtPath(at);
}

function writeUrl(key: string, url: string): void {
  try { window.localStorage.setItem(key, url); } catch { /* storage unavailable: the URL is just not remembered */ }
}

/**
 * The last URL a browser pane showed for this project and workstream in this
 * browser, and its setter. Shared by the workspace's dock and the simple UI's
 * side panel, so either one reopens on the same page.
 */
export function useRememberedBrowserUrl(projectId: string, workstream: string): [string, (next: string) => void] {
  const key = storageKey(projectId, workstream);
  // The remembered URL is read for the key being rendered, not for the one
  // the last render had: the dock stays mounted across a project switch, and
  // the pane it mounts for the new project dials with the URL it is given.
  const [remembered, setRemembered] = useState(() => ({ key, url: readUrl(key) }));
  const url = remembered.key === key ? remembered.url : readUrl(key);
  const onUrlChange = useCallback((next: string) => {
    setRemembered({ key, url: next });
    writeUrl(key, next);
  }, [key]);
  return [url, onUrlChange];
}

/**
 * The browser pane's home at the bottom of the ctrl column.
 * Collapsed it is a one-line bar; expanded it takes
 * most of the column and runs a headless Chromium on the project's box,
 * screencast into a canvas. Collapsing closes the browser: nothing runs on
 * the box while the pane is shut. The last URL is remembered per project and
 * workstream in this browser, so reopening lands on the same page.
 */
export function BrowserDock({ projectId, workstream, expanded, onToggle, openShare, onOpenShareUsed, showReset, onShare }: Props) {
  const [url, onUrlChange] = useRememberedBrowserUrl(projectId, workstream);

  return (
    <div className={`browser-dock ${expanded ? 'is-expanded' : ''}`}>
      <div
        className="browser-dock-bar"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        title={expanded ? 'Close the browser pane' : 'Open a browser on the box'}
      >
        <span className="browser-dock-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className="browser-dock-title">Browser</span>
        {url && !expanded && <span className="browser-dock-url" title={url}>{url}</span>}
        <span className="browser-dock-spacer" />
        {onShare && (
          <button
            type="button"
            className="browser-dock-btn"
            title="Share this preview with someone: their own browser, nothing else of the project"
            onClick={e => { e.stopPropagation(); onShare(sharePagePath(url)); }}
          >
            Share…
          </button>
        )}
        <button
          type="button"
          className="browser-dock-btn"
          onClick={e => { e.stopPropagation(); onToggle(); }}
        >
          {expanded ? 'Close' : 'Open'}
        </button>
      </div>
      {expanded && (
        <div className="browser-dock-body">
          <BrowserPane
            projectId={projectId}
            workstream={workstream}
            url={url || 'about:blank'}
            onUrlChange={onUrlChange}
            openShare={openShare}
            onOpenShareUsed={onOpenShareUsed}
            showReset={showReset}
            key={`${projectId}-${workstream}`}
          />
        </div>
      )}
    </div>
  );
}
