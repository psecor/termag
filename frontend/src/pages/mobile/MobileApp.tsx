// The phone client: an attention-sorted session list, a
// search tab, a chat
// view over the agent pane, and the PR pipeline. Mounted at /m/* inside the same providers as the
// workspace (auth, flags, connection, projects) but without
// MainLayout — no terminals, no starfield.
import React, { useEffect, useRef } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { ConnectionOverlay } from '../../components/ConnectionOverlay';
import { useAuth } from '../../contexts/AuthContext';
import { useProjects } from '../../contexts/ProjectContext';
import { boxFeed } from '../../services/boxFeed';
import { NAVIGATE_EVENT, routerPathFor } from '../../mobile/push';
import { useInferredNotificationTap } from '../../mobile/useInferredNotificationTap';
import { useAttentionSync, useServiceWorkerUpkeep } from '../../mobile/phoneNotifications';
import { useVisualViewport } from '../../hooks/useVisualViewport';
import { Inbox } from './Inbox';
import { Conversation } from './Conversation';
import { NewProject } from './NewProject';
import { NewAutomation } from './NewAutomation';
import { Prs } from './Prs';
import { Search } from './Search';
import { Share } from './Share';
import { useZoomableViewport } from '../../hooks/useZoomableViewport';
import './mobile.css';

/** A notification click routes here in place (main.tsx raises the event). */
function useNotificationNavigation() {
  const navigate = useNavigate();
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const path = routerPathFor((e as CustomEvent<URL>).detail);
      if (!path) return;
      e.preventDefault();
      navigate(path);
    };
    window.addEventListener(NAVIGATE_EVENT, onNavigate);
    return () => window.removeEventListener(NAVIGATE_EVENT, onNavigate);
  }, [navigate]);
}

export default function MobileApp() {
  const root = useRef<HTMLDivElement>(null);
  useNotificationNavigation();
  useInferredNotificationTap();
  useZoomableViewport();
  useVisualViewport(root);
  useAttentionSync();
  // The box list tells a conversation whether its box is parked, so opening
  // one can start it (hooks/useStartParkedBoxOnOpen), as in the workspace.
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    boxFeed.start();
    return () => boxFeed.stop();
  }, [user]);
  useServiceWorkerUpkeep();
  return (
    <div className="m-root" ref={root}>
      <ConnectionOverlay />
      <Routes>
        <Route index element={<Inbox />} />
        <Route path="p/:projectId" element={<Conversation />} />
        <Route path="search" element={<Search />} />
        <Route path="new" element={<NewProject />} />
        <Route path="new-automation" element={<NewAutomation />} />
        <Route path="prs" element={<Prs />} />
        <Route path="share" element={<Share />} />
        <Route path="*" element={<Navigate to="/m" replace />} />
      </Routes>
    </div>
  );
}
