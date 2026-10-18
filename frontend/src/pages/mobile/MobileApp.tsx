// The phone client: an attention-sorted session list, a
// search tab, a chat
// view over the agent pane, and the PR pipeline. Mounted at /m/* inside the same providers as the
// workspace (auth, flags, connection, projects) but without
// MainLayout — no terminals, no starfield.
import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ConnectionOverlay } from '../../components/ConnectionOverlay';
import { Inbox } from './Inbox';
import { Conversation } from './Conversation';
import { NewProject } from './NewProject';
import { Prs } from './Prs';
import { Search } from './Search';
import './mobile.css';

export default function MobileApp() {
  return (
    <div className="m-root">
      <ConnectionOverlay />
      <Routes>
        <Route index element={<Inbox />} />
        <Route path="p/:projectId" element={<Conversation />} />
        <Route path="search" element={<Search />} />
        <Route path="new" element={<NewProject />} />
        <Route path="prs" element={<Prs />} />
        <Route path="*" element={<Navigate to="/m" replace />} />
      </Routes>
    </div>
  );
}
