import React, { useState } from 'react';
import { clearShareConfirmSkips, shareConfirmSkips } from '../../chat/fileShare';

function localStore(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/**
 * The spaces where sharing a file skips its confirmation ("Don't ask again"
 * in the simple UI's file view). Only shown once there is one; cleared for
 * every space at once, in this browser.
 */
export function FileSharingSection() {
  const [skips, setSkips] = useState(() => shareConfirmSkips(localStore()));
  const [cleared, setCleared] = useState(false);
  if (skips.length === 0 && !cleared) return null;
  return (
    <section className="dash-section" id="file-sharing" aria-labelledby="file-sharing-h">
      <div className="dash-section-title" id="file-sharing-h">File sharing</div>
      <div className="dash-card settings-row">
        <div className="settings-row-text">
          {cleared ? (
            <span className="settings-row-name" role="status">termag will ask again before sharing a file with everyone on termag.</span>
          ) : (
            <>
              <span className="settings-row-name">Sharing a file doesn't ask first in {skips.join(', ')}</span>
              <span className="settings-row-meta">You ticked "Don't ask again" when sharing a file there. This is kept in this browser only.</span>
            </>
          )}
        </div>
        {!cleared && (
          <button type="button" className="btn-ghost" onClick={() => { clearShareConfirmSkips(localStore()); setSkips([]); setCleared(true); }}>
            Ask again
          </button>
        )}
      </div>
    </section>
  );
}
