import React from 'react';
import { isChunkLoadError, shouldReloadForStaleChunk } from '../utils/staleChunk';

interface State { error: Error | null; stale: boolean }

/**
 * The last line of defence under the router: a render error anywhere below
 * shows a short message and a Reload button instead of a blank page.
 *
 * One case is handled specially. A lazy route whose chunk no longer exists
 * (the orchestrator rolled to a new build while this page was open; see
 * utils/staleChunk.ts) reloads the page once, automatically; if the guard
 * says a reload was already tried, the message says what happened so the
 * user is not left guessing.
 */
export class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null, stale: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, stale: isChunkLoadError(error) };
  }

  componentDidCatch(error: Error): void {
    if (isChunkLoadError(error) && shouldReloadForStaleChunk(typeof sessionStorage !== 'undefined' ? sessionStorage : null, Date.now())) {
      window.location.reload();
      return;
    }
    console.error('[termag] render error', error);
  }

  render(): React.ReactNode {
    const { error, stale } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="loading-screen app-error" role="alert">
        <div className="app-error-card">
          <p className="app-error-title">
            {stale ? 'termag was updated while this page was open.' : 'Something went wrong.'}
          </p>
          <p className="app-error-text">
            {stale
              ? 'Part of the app could not load because it belongs to the previous version. Reload to pick up the new one.'
              : 'Reloading usually clears it. If it keeps happening, the message below is what to report.'}
          </p>
          {!stale && <pre className="app-error-detail">{error.message}</pre>}
          <button type="button" className="app-error-reload" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
