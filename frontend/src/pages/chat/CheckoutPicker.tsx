// How a New session gets its code, in the drawer beside the box and the space
// (pages/chat/LaunchDrawer.tsx): its own clone, as a new project (the
// default), or a worktree of a project already on the chosen box with the
// same repository (chat/newChat.ts worktreeTargets). A worktree is a new
// workstream of that project: no clone, and its permissions are the
// project's. It starts from origin/<default> as fetched now (the default), or
// from the project's checkout, whatever branch that is on, as the full UI's
// Branch off… does; the choice opens inside the card once it is picked.
// Shown only when there is a project to branch off.
import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '../../types';
import { Dialog } from '../../components/Dialog';
import { Tooltip } from '../../components/Tooltip';

export const OWN_CLONE = 'clone';

/** Where a worktree starts: origin's default branch, fetched now, or the project's checkout. */
export type WorktreeBase = 'origin' | 'checkout';

function BranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="5.5" r="1.6" />
      <path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-2 3.2-5.5 4" />
    </svg>
  );
}

/** The trigger's label for a choice. */
export function checkoutLabel(choice: string, targets: readonly Pick<Project, 'id' | 'name'>[]): string {
  const target = targets.find(p => p.id === choice);
  return target ? `Worktree of ${target.name}` : 'Own clone';
}

export function CheckoutPicker({ choice, onChoice, base, onBase, targets, defaultBranchOf, repoName, disabled, onOpen }: {
  /** OWN_CLONE, or the id of the project to branch a worktree off. */
  choice: string;
  onChoice: (choice: string) => void;
  base: WorktreeBase;
  onBase: (base: WorktreeBase) => void;
  targets: readonly Project[];
  /**
   * The branch origin/<branch> starts from: the project's default branch, or
   * the picked repository's. Null when neither is known (a project made from
   * a pasted URL): then only the project's checkout is offered, never a
   * guessed `main`.
   */
  defaultBranchOf: (p: Project) => string | null;
  /** The picked repository, owner/name, for the copy. */
  repoName: string;
  disabled?: boolean;
  /** The dialog is opening, so the page can close its menus. */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const target = targets.find(p => p.id === choice) ?? null;

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function pick(next: string) {
    onChoice(next);
    close();
  }

  return (
    <>
      <Tooltip content={<><strong>How this session gets the code</strong><span className="ui-tooltip-sub">{target
        ? `A new branch from ${base === 'origin' ? `origin/${defaultBranchOf(target)}, fetched now` : `${target.name}'s checkout`}, on its box: no clone`
        : `A fresh clone of ${repoName}, as a project of its own`}</span></>}>
        <button
          ref={triggerRef}
          type="button"
          className="chat-launch-trigger chat-checkout-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Checkout, ${checkoutLabel(choice, targets)}`}
          disabled={disabled}
          onClick={() => { if (disabled) return; onOpen?.(); setOpen(true); }}
        >
          <BranchIcon />
          <span className="chat-launch-trigger-label">{checkoutLabel(choice, targets)}</span>
        </button>
      </Tooltip>
      {open && createPortal(
        <Dialog title="How this session gets the code" onClose={close} className="chat-launch-dialog chat-checkout-dialog">
          <div className="chat-launch-boxes" role="radiogroup" aria-label="Checkout">
            <button
              type="button"
              role="radio"
              aria-checked={!target}
              className="chat-launch-box"
              onClick={() => pick(OWN_CLONE)}
            >
              <span className="chat-launch-box-name">Its own clone</span>
              <small>A new project with a fresh clone of {repoName}</small>
            </button>
            <div className="chat-menu-heading">A worktree of</div>
            {targets.map(p => {
              const picked = target?.id === p.id;
              return (
                // A worktree and where it starts are one choice: the start opens inside it once picked.
                <div key={p.id} className="chat-launch-new" data-checked={picked || undefined}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={picked}
                    className="chat-launch-box"
                    onClick={() => onChoice(p.id)}
                  >
                    <span className="chat-launch-box-name">{p.name}</span>
                    <small>A new branch, no clone. Its permissions are {p.name}'s.</small>
                  </button>
                  {picked && (
                    <div className="chat-launch-new-name chat-checkout-base">
                      <span id={`${p.id}-base`}>Start from</span>
                      <div className="chat-checkout-base-options" role="radiogroup" aria-labelledby={`${p.id}-base`}>
                        {defaultBranchOf(p) && (
                          <button type="button" role="radio" aria-checked={base === 'origin'} className="chat-checkout-base-option" onClick={() => onBase('origin')}>
                            origin/{defaultBranchOf(p)}
                          </button>
                        )}
                        <button type="button" role="radio" aria-checked={base === 'checkout'} className="chat-checkout-base-option" onClick={() => onBase('checkout')}>
                          {p.name}'s checkout
                        </button>
                      </div>
                      <small>{base === 'origin'
                        ? 'Its latest commit, fetched as the session starts.'
                        : `Whatever branch ${p.name}'s checkout is on now.`}</small>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="chat-launch-dialog-actions">
            <button type="button" className="btn-primary" onClick={close}>Done</button>
          </div>
        </Dialog>,
        document.body,
      )}
    </>
  );
}
