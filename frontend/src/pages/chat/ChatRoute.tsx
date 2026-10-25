// One conversation: the SDK chat when the workstream's Claude runs in the
// box's chat runner, else the pane chat (Claude, or another agent, in its
// terminal pane), which stays the fallback for every other project.
import React, { useSyncExternalStore } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useProjects } from '../../contexts/ProjectContext';
import { archivedChatOpen, readRunningBox, recoveryForOpen, subscribeRunningBoxes } from '../../chat/archive';
import { isSdkChat } from '../../chat/simpleChat';
import { boxFeed } from '../../services/boxFeed';
import { ChatView } from './ChatView';
import { RunningBoxRecoveryView } from './RunningBoxRecovery';
import { SdkChatView } from './SdkChatView';

export function ChatRoute() {
  const { projectId = '' } = useParams();
  const [params] = useSearchParams();
  const { projects } = useProjects();
  const workstream = params.get('ws') || 'main';
  const project = projects.find(p => p.id === projectId);
  const stored = useSyncExternalStore(subscribeRunningBoxes, () => readRunningBox(projectId));
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const boxStatus = stored?.instanceId ? boxes.find(b => b.id === stored.instanceId)?.status : undefined;
  const recovery = recoveryForOpen(stored, boxStatus, boxFeed.hasLoaded());
  const open = archivedChatOpen(Boolean(project && isSdkChat(project, workstream)), recovery);
  if (open === 'live' && project) return <SdkChatView key={`${project.id}|${workstream}`} project={project} workstream={workstream} />;
  if (open === 'recovery' && recovery) return <RunningBoxRecoveryView recovery={recovery} />;
  return <ChatView />;
}
