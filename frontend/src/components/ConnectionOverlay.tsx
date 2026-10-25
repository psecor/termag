import React, { useEffect, useRef, useState } from 'react';
import { reauthenticate, retryConnection, useConnection } from '../contexts/ConnectionContext';
import { TAKEOVER, formatSince, takeoverVisible } from '../utils/connection';

/**
 * Full-viewport takeover for sustained offline. Dims the whole app (the
 * frozen grey starfield stays visible behind it) and puts the state where it
 * cannot be read past. Interaction underneath is blocked by default — typing
 * into a dead socket is silently buffered, which is worse than a blocked
 * click — with a "peek" escape hatch for reading or copying stale output.
 *
 * Degraded is deliberately NOT handled here; it keeps the one-line banner.
 *
 * An expired edge session takes over at once instead, as a sign-in prompt: the
 * tab waits for a click or key press before going to Okta (markEdgeSignedOut).
 */
export function ConnectionOverlay() {
  const { state, lastContactAt, now, signedOut } = useConnection();

  // When did we enter offline? Tracked here rather than in the provider so
  // the escalation delay is a presentation concern.
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const [peekUntil, setPeekUntil] = useState<number | null>(null);
  const [reconnectedAt, setReconnectedAt] = useState<number | null>(null);
  const prevState = useRef(state);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const was = prevState.current;
    prevState.current = state;
    if (state === 'offline' && was !== 'offline') {
      setOfflineSince(Date.now());
      setPeekUntil(null);
    }
    if (state !== 'offline') {
      setOfflineSince(null);
      setPeekUntil(null);
    }
    if (state === 'online' && was === 'offline') {
      setReconnectedAt(Date.now());
    }
  }, [state]);

  // Let the "reconnected" note expire on the provider's clock.
  const showReconnected = reconnectedAt != null && now - reconnectedAt < TAKEOVER.reconnectedNoteMs;
  useEffect(() => {
    if (reconnectedAt != null && !showReconnected) setReconnectedAt(null);
  }, [reconnectedAt, showReconnected]);

  const visible = signedOut || takeoverVisible({ state, offlineSince, peekUntil, now });

  // Take focus so the notice is announced and Escape works; Escape = peek.
  useEffect(() => {
    if (!visible) return;
    panelRef.current?.focus();
    // Any key signs a signed-out tab in (the provider's listener); no peek.
    if (signedOut) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setPeekUntil(Date.now() + TAKEOVER.peekMs); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, signedOut]);

  const [probing, setProbing] = useState(false);
  const retryNow = async () => {
    if (probing) return;
    setProbing(true);
    try { await retryConnection(); } finally { setProbing(false); }
  };

  const peeking = !signedOut && state === 'offline' && peekUntil != null && now < peekUntil;

  return (
    <>
      {visible && signedOut && (
        <div className="connection-takeover" role="alertdialog" aria-modal="true" aria-labelledby="connection-takeover-title">
          <div className="connection-takeover-panel" ref={panelRef} tabIndex={-1}>
            <div className="connection-takeover-title" id="connection-takeover-title">Signed out of termag</div>
            <div className="connection-takeover-message">
              Your sign-in expired. Click anywhere or press any key to sign in again.
            </div>
            <div className="connection-takeover-actions">
              <button className="terminal-reconnect-button" onClick={reauthenticate} autoFocus>Sign in</button>
            </div>
          </div>
        </div>
      )}
      {visible && !signedOut && (
        <div className="connection-takeover" role="alertdialog" aria-modal="true" aria-labelledby="connection-takeover-title">
          <div className="connection-takeover-panel" ref={panelRef} tabIndex={-1}>
            <div className="connection-takeover-title" id="connection-takeover-title">Connection to termag lost</div>
            <div className="connection-takeover-message">
              {lastContactAt != null
                ? <>Last contact {formatSince(now - lastContactAt)} ago, at {new Date(lastContactAt).toLocaleTimeString()}.</>
                : <>No contact with the server yet.</>}
              <br />
              The terminals behind this notice are a snapshot from before the connection dropped. Retrying automatically.
            </div>
            <div className="connection-takeover-actions">
              <button className="terminal-reconnect-button" onClick={retryNow} disabled={probing} autoFocus>
                {probing ? 'Checking…' : 'Retry now'}
              </button>
              <button
                className="connection-takeover-peek"
                onClick={() => setPeekUntil(Date.now() + TAKEOVER.peekMs)}
                title={`Hide this for ${Math.round(TAKEOVER.peekMs / 1000)}s to read or copy stale output (Esc)`}
              >
                Peek at stale terminals
              </button>
            </div>
          </div>
        </div>
      )}
      {peeking && (
        <div className="connection-peek-pill" role="status">
          offline · showing stale terminals · back in {Math.max(0, Math.ceil((peekUntil! - now) / 1000))}s
        </div>
      )}
      {showReconnected && (
        <div className="connection-reconnected-note" role="status" aria-live="polite">Reconnected</div>
      )}
    </>
  );
}
