// The bottom tab bar (Slack-style, user decision 2026-10-11): Sessions and
// Search, in thumb reach, and Chat, the way to the simple UI. Sessions carries the awaiting-you count.
import React from 'react';
import { Link, NavLink } from 'react-router-dom';
import { CHAT_HOME_HREF } from '../../mobile/chatLinks';

export function TabBar({ attention }: { attention: number }) {
  return (
    <nav className="m-tabbar" aria-label="Main">
      <NavLink end to="/m" className={({ isActive }) => `m-tabbar-item ${isActive ? 'active' : ''}`}>
        <span className="m-tabbar-icon" aria-hidden>◐</span>
        <span className="m-tabbar-label">Sessions</span>
        {attention > 0 && <span className="m-tabbar-count" aria-label={`${attention} waiting on you`}>{attention}</span>}
      </NavLink>
      <NavLink to="/m/search" className={({ isActive }) => `m-tabbar-item ${isActive ? 'active' : ''}`}>
        <span className="m-tabbar-icon" aria-hidden>⌕</span>
        <span className="m-tabbar-label">Search</span>
      </NavLink>
      {/* Leaves /m, so it is never the active tab: a plain Link. */}
      <Link to={CHAT_HOME_HREF} className="m-tabbar-item" data-analytics="mobile-open-chat">
        <span className="m-tabbar-icon" aria-hidden>❝</span>
        <span className="m-tabbar-label">Chat</span>
      </Link>
    </nav>
  );
}
