// The bottom tab bar (Slack-style, user decision 2026-10-11): Sessions and
// Search, in thumb reach. Sessions carries the awaiting-you count.
import React from 'react';
import { NavLink } from 'react-router-dom';

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
    </nav>
  );
}
