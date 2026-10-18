// The simple UI (docs: simple-ui plan, milestone 1): a chat-first desktop
// client at /chat. A sidebar of conversations and one conversation at a time,
// each a project workstream's agent session shown as a chat over its pane.
// Mounted inside the same providers as the workspace, without MainLayout:
// no terminals (Open in full UI is the way to one), no starfield. Behind
// simple-ui-enabled.
import React, { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ConnectionOverlay } from '../../components/ConnectionOverlay';
import { boxFeed } from '../../services/boxFeed';
import { ChatSidebar } from './ChatSidebar';
import { NewChat } from './NewChat';
import { ChatRoute } from './ChatRoute';
import './chat.css';

function ChatHome() {
  return (
    <div className="chat-home">
      <h1>termag</h1>
      <p>Pick a conversation on the left, or start a new chat from a repository.</p>
    </div>
  );
}

export default function ChatApp() {
  const { user } = useAuth();

  // The box list drives the setup state of a conversation whose box is
  // still coming up (hooks/useSetupContext), as it does in the workspace.
  useEffect(() => {
    if (!user) return;
    boxFeed.start();
    return () => boxFeed.stop();
  }, [user]);

  return (
    <div className="chat-root">
      <ConnectionOverlay />
      <ChatSidebar />
      <main className="chat-main">
        <Routes>
          <Route index element={<ChatHome />} />
          <Route path="new" element={<NewChat />} />
          <Route path="p/:projectId" element={<ChatRoute />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </main>
    </div>
  );
}
