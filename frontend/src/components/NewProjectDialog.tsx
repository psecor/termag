import React from 'react';
import { createPortal } from 'react-dom';
import { useProjects } from '../contexts/ProjectContext';
import { Dialog } from './Dialog';
import { NewProjectForm } from './NewProjectForm';

/**
 * The sidebar's "New project" button opens this: the shared NewProjectForm in
 * a modal (same backdrop as ConfirmDialog, Escape and backdrop-click close).
 * Creating a project reloads the list, opens it, and closes the dialog. A box
 * left provisioning when the dialog closes keeps going server-side and shows
 * up in the sidebar's Boxes section.
 */
export function NewProjectDialog({
  onClose,
  initialBoxId,
  onBranchOff,
}: {
  onClose: () => void;
  initialBoxId?: string;
  onBranchOff?: (projectId: string) => void;
}) {
  const { reloadProjects, setActiveProject } = useProjects();

  return createPortal(
    <Dialog title="New project" className="np-dialog" onClose={onClose}>
      <NewProjectForm
        autoFocus
        initialBoxId={initialBoxId}
        onBranchOff={onBranchOff}
        submitLabel="Create and open"
        actions={<button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>}
        onCreated={async project => {
          await reloadProjects();
          setActiveProject(project.id);
          onClose();
        }}
      />
    </Dialog>,
    document.body,
  );
}
