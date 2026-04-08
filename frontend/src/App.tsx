import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ProjectProvider } from './contexts/ProjectContext';
import { ProjectControl } from './components/ProjectControl';
import { Terminal } from './components/Terminal';
import { Hyperspace } from './components/Hyperspace';
import { useProjects } from './contexts/ProjectContext';
import { useAuth as useAuthHook } from './contexts/AuthContext';

function Login() {
  return (
    <div className="login-page">
      <div className="login-card">
        <h1>termag</h1>
        <p>Workspace manager</p>
        <a href="/termag/auth/google" className="btn-primary">Sign in with Google</a>
      </div>
    </div>
  );
}

function MainLayout() {
  const { user } = useAuthHook();
  const { projects, activeProjectId, statusMap } = useProjects();

  const activeProject = projects.find(p => p.id === activeProjectId);
  const hasAgent = activeProject?.workflows.some(w => w.type === 'agent');
  const username = user?.unixUsername ?? '';

  // Count how many agents are currently working
  const workingCount = projects.filter(p => {
    const agentSession = `${username}-${p.name}-agent`;
    return statusMap[agentSession]?.status === 'working';
  }).length;

  // Typing boost — decays after 1.5s of no keystrokes
  const [typing, setTyping] = useState(false);
  const [warpSpeed, setWarpSpeed] = useState(0.1);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onActivity = useCallback(() => {
    setTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(false), 1500);
  }, []);

  const isActive = workingCount > 0 || typing;
  const warpStr = warpSpeed < 10 ? warpSpeed.toFixed(1) : Math.floor(warpSpeed).toString();


  return (
    <div className="app-layout">
      <div className="app-hyperspace-bg">
        <Hyperspace activeCount={workingCount} typingBoost={typing} onWarpChange={setWarpSpeed} />
      </div>
      <div className="warp-indicator" data-active={isActive || undefined}>
        {warpStr}<em>c</em>
      </div>
      <div className="app-sidebar">
        <div className="app-control">
          <ProjectControl />
        </div>
      </div>
      <div className="app-agent" id="terminal-agent">
        {activeProject && hasAgent ? (
          <Terminal
            sessionName={`${username}-${activeProject.name}-agent`}
            active={true}
            autoFocus={true}
            onActivity={onActivity}
            key={`${activeProject.id}-agent`}
          />
        ) : (
          <div className="empty-pane">
            {activeProject ? 'Add an agent workflow →' : 'Select a project'}
          </div>
        )}
      </div>
      <div className="app-ctrl" id="terminal-ctrl">
        {activeProject && hasAgent ? (
          <Terminal
            sessionName={`${username}-${activeProject.name}-ctrl`}
            active={true}
            onActivity={onActivity}
            key={`${activeProject.id}-ctrl`}
          />
        ) : (
          <div className="empty-pane">
            {activeProject ? 'Add an agent workflow →' : 'Select a project'}
          </div>
        )}
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-screen">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <ProjectProvider>
                <MainLayout />
              </ProjectProvider>
            </RequireAuth>
          }
        />
      </Routes>
    </AuthProvider>
  );
}
