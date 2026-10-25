import React from 'react';
import { createPortal } from 'react-dom';
import { useProjects } from '../contexts/ProjectContext';
import { Dialog } from './Dialog';
import { NewProjectForm, type NewProjectMode } from './NewProjectForm';

/**
 * The sidebar's "New project" button opens this: the shared NewProjectForm in
 * a modal (same backdrop as ConfirmDialog, Escape and backdrop-click close).
 * Creating a project reloads the list, opens it, and closes the dialog. A box
 * left provisioning when the dialog closes keeps going server-side and shows
 * up in the sidebar's Boxes section. In `automation` mode (Shift on the
 * button, the split button's caret) the same form
 * creates an automation instead.
 */
export function NewProjectDialog({
  onClose,
  initialBoxId,
  onBranchOff,
  mode = 'project',
}: {
  onClose: () => void;
  initialBoxId?: string;
  onBranchOff?: (projectId: string) => void;
  mode?: NewProjectMode;
}) {
  const { reloadProjects, setActiveProject } = useProjects();

  return createPortal(
    <Dialog title={mode === 'automation' ? 'New automation' : 'New project'} className="np-dialog" onClose={onClose}>
      <NewProjectForm
        autoFocus
        mode={mode}
        initialBoxId={initialBoxId}
        onBranchOff={onBranchOff}
        submitLabel={mode === 'automation' ? 'Create automation' : 'Create and open'}
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
