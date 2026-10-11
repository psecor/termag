import React from 'react';
import { createPortal } from 'react-dom';
import { useProjects } from '../contexts/ProjectContext';
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
  // The form's autoFocus puts focus on its first select, inside this element,
  // so Escape reaches the onKeyDown below without anything being clicked.

  return createPortal(
    <div className="confirm-backdrop" onClick={onClose}>
      <div
        className="confirm-dialog np-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="np-dialog-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}
      >
        <div className="np-dialog-title" id="np-dialog-title">New project</div>
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
      </div>
    </div>,
    document.body,
  );
}
