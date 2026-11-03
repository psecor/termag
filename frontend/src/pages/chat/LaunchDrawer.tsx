// New session's drawer: a strip tucked under the composer that says where
// and when the session runs. Each setting is a trigger on the left opening a
// dialog: the box (New box or one of yours, and the names), the space
// (pages/chat/SpacePicker.tsx), when the chosen box already has the
// repository how the session gets the code (pages/chat/CheckoutPicker.tsx),
// and the schedule (pages/chat/SchedulePicker.tsx).
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Instance } from '../../types';
import { Dialog } from '../../components/Dialog';
import { Tooltip } from '../../components/Tooltip';
import { boxIsUsableForProject } from '../../utils/projectStart';
import { canStartBox } from '../../utils/boxPower';
import { boxDiskLabel } from '../../utils/boxDisk';
import { boxSizeName } from '../../utils/boxSize';

export const NEW_BOX = 'new';

function BoxIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.8 13.5 4.6v6.8L8 14.2 2.5 11.4V4.6z M2.5 4.6 8 7.4l5.5-2.8 M8 7.4v6.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Boxes a session can go on: up or coming up, or asleep and woken when picked.
 * An asleep box is offered only when the owner-only start route would take it
 * (utils/boxPower.ts canStartBox), so picking one never asks for a wake that
 * cannot happen.
 */
export function launchableBoxes(boxes: readonly Instance[]): Instance[] {
  return boxes.filter(b => boxIsUsableForProject(b) || canStartBox(b));
}

/** The line under a box's name in the box dialog, ending with its size and disk (utils/boxDisk.ts) when it has them. */
export function boxLine(b: Pick<Instance, 'status' | 'projects' | 'size' | 'instanceType' | 'diskGiB'>, waking: boolean): string {
  const size = [boxSizeName(b.size, b.instanceType), boxDiskLabel(b.diskGiB)].filter(Boolean).map(t => ` · ${t}`).join('');
  if (waking || b.status === 'starting') return `Waking up…${size}`;
  if (b.status === 'hibernated') return `Hibernated · wakes when you pick it${size}`;
  if (b.status === 'stopped') return `Stopped · wakes when you pick it${size}`;
  if (b.status !== 'ready') return `Coming up…${size}`;
  const n = b.projects?.length ?? 0;
  return (n === 0 ? 'Running' : `Running · ${n} ${n === 1 ? 'session' : 'sessions'}`) + size;
}

export function LaunchDrawer({ boxes, boxChoice, onBoxChoice, wakingId, space, checkout, schedule, newBoxName, newBoxSize, sessionName, disabled, boxLocked }: {
  boxes: readonly Instance[];
  boxChoice: string;
  onBoxChoice: (choice: string) => void;
  wakingId: string | null;
  /** The space picker's trigger, which opens its own dialog. */
  space: React.ReactNode;
  /** The checkout picker's trigger, when there is a project to branch a worktree off. */
  checkout?: React.ReactNode;
  /** The schedule picker's trigger, which opens its own dialog. */
  schedule?: React.ReactNode;
  /** The new box's name field, inside the New box choice while it is picked. */
  newBoxName: React.ReactNode;
  /** The new box's size picker (components/BoxSizePicker.tsx), under its name; null while there is nothing to pick. */
  newBoxSize?: React.ReactNode;
  /** The session's name field, under the boxes. */
  sessionName: React.ReactNode;
  disabled?: boolean;
  /**
   * The box is settled: one was launched for a start the server then refused.
   * The retry uses that box, so the choice of box is fixed, but the dialog
   * still opens for the session name, which may be what was refused.
   */
  boxLocked?: boolean;
}) {
  const [boxOpen, setBoxOpen] = useState(false);
  const chosen = boxes.find(b => b.id === boxChoice) ?? null;
  return (
    <div className="chat-launch-drawer">
      <div className="chat-launch-strip">
        <Tooltip content={<><strong>Where this session runs</strong><span className="ui-tooltip-sub">{chosen ? `${chosen.name}: ${boxLine(chosen, wakingId === chosen.id)}` : 'A new box of its own, from the warm pool when there is one'}</span></>}>
        <button
          type="button"
          className="chat-launch-trigger"
          aria-haspopup="dialog"
          aria-expanded={boxOpen}
          disabled={disabled}
          onClick={() => setBoxOpen(true)}
        >
          <BoxIcon />
          <span className="chat-launch-trigger-label">{chosen ? chosen.name : 'New box'}</span>
        </button>
        </Tooltip>
        {space}
        {checkout}
        {schedule}
      </div>
      {boxOpen && createPortal(
        <Dialog title="Where this session runs" onClose={() => setBoxOpen(false)} className="chat-launch-dialog">
          <div className="chat-launch-boxes" role="radiogroup" aria-label="Box">
            {/* New box and its name are one choice: the name field opens inside it once picked. */}
            <div className="chat-launch-new" data-checked={boxChoice === NEW_BOX || undefined}>
              <button
                type="button"
                role="radio"
                aria-checked={boxChoice === NEW_BOX}
                className="chat-launch-box"
                disabled={boxLocked}
                onClick={() => onBoxChoice(NEW_BOX)}
              >
                <span className="chat-launch-box-name">New box</span>
                <small>Its own box, from the warm pool when there is one</small>
              </button>
              {boxChoice === NEW_BOX && <div className="chat-launch-new-name">{newBoxName}{newBoxSize}</div>}
            </div>
            {boxes.length > 0 && <div className="chat-menu-heading">Your boxes</div>}
            {boxes.map(b => (
              <button
                key={b.id}
                type="button"
                role="radio"
                aria-checked={boxChoice === b.id}
                className="chat-launch-box"
                data-status={wakingId === b.id ? 'starting' : b.status}
                disabled={boxLocked}
                onClick={() => onBoxChoice(b.id)}
              >
                <span className="chat-launch-box-name">{b.name}</span>
                <small><span className="chat-launch-box-dot" aria-hidden="true" />{boxLine(b, wakingId === b.id)}</small>
              </button>
            ))}
          </div>
          <div className="chat-launch-names">{sessionName}</div>
          <div className="chat-launch-dialog-actions">
            <button type="button" className="btn-primary" onClick={() => setBoxOpen(false)}>Done</button>
          </div>
        </Dialog>,
        document.body,
      )}
    </div>
  );
}
