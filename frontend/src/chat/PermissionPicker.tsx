// What a new session's Claude may do, as an icon pill in New session's bar.
// The two choices are the trust tick's (services/chatTrust.ts on the server):
// Full access records it (bypassPermissions), Read only leaves the session
// read-only until it is trusted from the session. The trigger names the
// choice beside its icon.
import React, { useEffect, useRef } from 'react';
import { Tooltip } from '../components/Tooltip';

export type PermissionChoice = 'read' | 'full';

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9 1.8 3.8 9h3.6L6.8 14.2 12.2 7H8.6z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

const LABEL: Record<PermissionChoice, string> = { read: 'Read only', full: 'Full access' };

/** What each choice means; an automation's runs read the same tick as their tier. */
export function permissionHint(choice: PermissionChoice, scheduled: boolean): string {
  if (scheduled) {
    return choice === 'full'
      ? 'Runs commit and open PRs with nobody watching. Its classifier denies rather than asks.'
      : 'Every run is read-only.';
  }
  return choice === 'full'
    ? 'Runs commands and edits files in its box without asking.'
    : 'Reads the code and answers. No commands or edits until you trust it from the session.';
}

function LinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M6.6 9.4 9.4 6.6M7.3 4.6l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1M8.7 11.4l-1 1A2.6 2.6 0 0 1 4 8.7l1-1" />
    </svg>
  );
}

/**
 * The pill in place of the picker for a worktree session (pages/chat/
 * CheckoutPicker.tsx): a workstream runs with its project's permissions, so
 * there is no choice to make here, only whose they are.
 */
export function FollowsPermissions({ project, fetched = false }: {
  project: string;
  /** From a fresh fetch of a read-only project: read only for good, whatever the project later gets. */
  fetched?: boolean;
}) {
  const sub = fetched
    ? `Read only, as ${project} is. A worktree of freshly fetched code stays read only, even if ${project} is trusted later.`
    : `A worktree runs with its project's permissions. Trust ${project} or keep it read only from its session.`;
  return (
    <Tooltip content={<><strong>{project}'s permissions</strong><span className="ui-tooltip-sub">{sub}</span></>}>
      <span className="chat-compose-model-btn chat-permission-btn" data-choice="follows" tabIndex={0} aria-label={`Permissions: ${project}'s`}>
        <LinkIcon />
        <span>As {project}</span>
      </span>
    </Tooltip>
  );
}

export function PermissionPicker({ value, onChange, open, onOpenChange, scheduled = false, disabled, checkouts }: {
  value: PermissionChoice;
  onChange: (choice: PermissionChoice) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scheduled?: boolean;
  disabled?: boolean;
  /** What the choice is for, when that isn't the one repository picked: an environment's checkouts, each at its branch. */
  checkouts?: string[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) onOpenChange(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onOpenChange(false);
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div className="chat-compose-model chat-permission" ref={rootRef}>
      <Tooltip content={<><strong>{LABEL[value]}</strong><span className="ui-tooltip-sub">{permissionHint(value, scheduled)}</span></>}>
      <button
        type="button"
        className="chat-compose-model-btn chat-permission-btn"
        data-choice={value}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Permissions: ${LABEL[value]}`}
        disabled={disabled}
        onClick={() => { if (!disabled) onOpenChange(!open); }}
      >
        {value === 'full' ? <BoltIcon /> : <LockIcon />}
        <span>{LABEL[value]}</span>
      </button>
      </Tooltip>
      {open && (
        <div className="chat-compose-model-menu chat-permission-menu" role="listbox" aria-label="Permissions">
          <div className="chat-menu-heading">Permissions</div>
          {checkouts?.length ? (
            <div className="chat-permission-for">For {checkouts.map((c, i) => <span key={c}>{i ? ', ' : ''}<code>{c}</code></span>)}</div>
          ) : null}
          {(['read', 'full'] as const).map(choice => (
            <button
              key={choice}
              type="button"
              role="option"
              aria-selected={choice === value}
              className="chat-compose-option chat-permission-option"
              onClick={() => { onChange(choice); onOpenChange(false); }}
            >
              <span className="chat-permission-icon">{choice === 'full' ? <BoltIcon /> : <LockIcon />}</span>
              <span className="chat-permission-text">
                <span>{LABEL[choice]}</span>
                <small>{permissionHint(choice, scheduled)}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
