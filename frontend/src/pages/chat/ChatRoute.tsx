// One conversation: the SDK chat when the workstream's Claude runs in the
// box's chat runner, else the pane chat (Claude, or another agent, in its
// terminal pane), which stays the fallback for every other project.
import React from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useProjects } from '../../contexts/ProjectContext';
import { isSdkChat } from '../../chat/simpleChat';
import { ChatView } from './ChatView';
import { SdkChatView } from './SdkChatView';

export function ChatRoute() {
  const { projectId = '' } = useParams();
  const [params] = useSearchParams();
  const { projects } = useProjects();
  const workstream = params.get('ws') || 'main';
  const project = projects.find(p => p.id === projectId);
  if (project && isSdkChat(project, workstream)) return <SdkChatView key={`${project.id}|${workstream}`} project={project} workstream={workstream} />;
  return <ChatView />;
}
