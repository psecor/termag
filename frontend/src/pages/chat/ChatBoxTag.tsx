// The conversation header's box pill (components/BoxPill.tsx).
import React from 'react';
import type { Instance, Project } from '../../types';
import { boxLabel } from '../../chat/simpleChat';
import { BoxPill } from '../../components/BoxPill';

export function ChatBoxTag({ project, box }: { project: Project; box: Pick<Instance, 'name'> | null }) {
  const label = boxLabel(
    { instanceId: project.instanceId ?? null, shared: project.role === 'collaborator', owner: project.ownerUsername ?? '' },
    box?.name,
  );
  return label ? <BoxPill instanceId={project.instanceId} label={label} /> : null;
}
