// A session's state at a glance under the chrome refresh
// (chat/rowState.ts): LaunchPad's spinner
// while it works, a coloured dot when it needs you (amber to approve, blue to
// answer, red when it stopped), and nothing when it is done or not running,
// unless it came to rest since you looked (`unseen`): then the blue dot.
// Hidden from assistive tech: the row names the state in words beside it.
import React from 'react';
import { ProgressBar } from '@launchpad-ui/components';
import type { RowStateKind } from '../../chat/rowState';

export function StatusMark({ kind, unseen = false }: { kind: RowStateKind; unseen?: boolean }) {
  return (
    <span className="chat-status-mark" data-status={kind} data-unseen={unseen || undefined} aria-hidden="true">
      {kind === 'working' && <ProgressBar variant="spinner" size="small" isIndeterminate aria-label="Working" />}
      {(kind === 'approval' || kind === 'unread' || kind === 'error' || unseen) && <span className="chat-status-dot" />}
    </span>
  );
}
