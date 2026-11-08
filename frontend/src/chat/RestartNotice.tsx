// A tool update's restart notice in a pane chat's timeline (chat/chatNotices.ts):
// one muted line across the transcript where the session restarted, in the UI
// font, with when; another pane's restart is the same line without the rules,
// after the pane's blocks. Read-only text, so no control: nothing here is LaunchPad's.
import React from 'react';
import { noticePaneLabel, type ChatNotice } from './chatNotices';

function when(at: string): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** `side`: another pane's restart, as a note after the pane's blocks rather than a divider above them. */
export function RestartNotice({ notice, side = false }: { notice: ChatNotice; side?: boolean }) {
  const where = noticePaneLabel(notice.pane);
  return (
    <div className="chat-restart-notice" role="note" data-pane={notice.pane} data-side={side || undefined}>
      <span className="chat-restart-notice-text">
        {notice.text}
        {where && <span className="chat-restart-notice-where"> ({where})</span>}
        {' · '}
        <time dateTime={notice.at} title={new Date(notice.at).toLocaleString()}>{when(notice.at)}</time>
      </span>
    </div>
  );
}
