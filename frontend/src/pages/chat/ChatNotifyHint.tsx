// The chat view's only trace of "your turn" notifications:
// a one-time pointer to Settings → Notifications
// while they were never set up. Dismissing or following it hides it for good
// on this browser; the switch itself lives in Settings.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { SETUP_HINT_DISMISSED_KEY, showSetupHint } from '../../chat/turnNotify';
import { currentPermission, useChatTurnEnabled } from '../../chat/useChatTurnNotifications';

function readDismissed(): boolean {
  try { return window.localStorage.getItem(SETUP_HINT_DISMISSED_KEY) === '1'; } catch { return false; }
}

export function ChatNotifyHint() {
  const { user } = useAuth();
  const { flag } = useChatTurnEnabled();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!showSetupHint({ flag, optedIn: !!user?.chatTurnNotify, permission: currentPermission(), dismissed })) return null;

  const dismiss = () => {
    setDismissed(true);
    try { window.localStorage.setItem(SETUP_HINT_DISMISSED_KEY, '1'); } catch { /* private mode: hidden for this page only */ }
  };

  return (
    <div className="chat-notify-hint" role="note">
      <Link to="/settings?from=chat#notifications" onClick={dismiss}>Get notified when a session is ready</Link>
      <button type="button" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>×</button>
    </div>
  );
}
