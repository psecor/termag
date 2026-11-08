// New session's drawer: a strip tucked under the composer that says where
// and when the session runs. Each setting is a trigger on the left opening a
// dialog: the box (New box or one of yours, and the names; a New box whose
// name, size or disk was changed goes by its own name in the trigger and its
// choice, both marked new, with what was picked in their tooltips:
// newBoxSummary), the space
// (pages/chat/SpacePicker.tsx), the environment (pages/chat/EnvironmentSelect.tsx), when the chosen box already has the
// repository how the session gets the code (pages/chat/CheckoutPicker.tsx),
// and the schedule (pages/chat/SchedulePicker.tsx).
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Instance } from '../../types';
import { Dialog } from '../../components/Dialog';
import { Focusable, Tooltip, TooltipTrigger } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';
import { boxIsUsableForProject } from '../../utils/projectStart';
import { canStartBox } from '../../utils/boxPower';
import { LaunchChoice } from './LaunchChoice';
import { boxDiskLabel, diskToSend, type BoxDiskOptions } from '../../utils/boxDisk';
import { boxSizeName, preselectedSize, REPO_DEFAULT, sizeName, type BoxSizeOptions, type SizePick } from '../../utils/boxSize';

export const NEW_BOX = 'new';

/** Where a new box comes from, in its tooltips. */
const NEW_BOX_POOL = 'From the warm pool when there is one';

/** The box New box makes, as the drawer names it (newBoxSummary). */
export interface NewBoxSummary {
  /** Its name, size or disk was changed from what New chat offered: the drawer calls it by its name. */
  customized: boolean;
  /** The name it gets; '' while the name field is empty. */
  name: string;
  /** Its size and disk as a box row's line ends: "Large · 200 GB disk"; '' while neither is known yet. */
  settings: string;
  /**
   * The warm pool's disk when this box's is bigger (picked, or the repository's), so it is launched
   * rather than claimed; null while it could come from the pool.
   */
  poolDiskGiB: number | null;
}

/**
 * The new box from New chat's fields: the name typed (else the one offered),
 * the size picked (else what the server preselects, utils/boxSize.ts) and the
 * disk typed (else the repository's, utils/boxDisk.ts). A typed disk that
 * isn't a valid size counts as a change but isn't listed: the field says
 * what is wrong with it, and Send waits. Every warm-pool box has the default
 * disk, so a box with a bigger one never comes from the pool. A smaller one
 * may: the server raises a disk to its image's snapshot before it looks
 * (backend services/boxImageFloor.ts), and the full image's snapshot is the
 * default's 120 GB (packer/box.pkr.hcl), a floor the browser isn't told.
 */
export function newBoxSummary(i: {
  name: string;
  defaultName: string;
  sizes: BoxSizeOptions | null;
  picked: SizePick | null;
  disk: BoxDiskOptions | null;
  typed: string | null;
}): NewBoxSummary {
  const name = i.name.trim();
  const preselected = i.sizes ? preselectedSize(i.sizes) : null;
  const size = i.sizes ? i.picked ?? preselected : null;
  const sizeLabel = !size ? null : size === REPO_DEFAULT ? i.sizes?.defaultRequirements?.instanceType ?? null : sizeName(size);
  const diskGiB = !i.disk ? null : i.typed === null ? i.disk.diskGiB : diskToSend(i.disk, i.typed) ?? null;
  const customized = (!!name && name !== i.defaultName)
    || (i.picked !== null && i.picked !== preselected)
    || (!!i.disk && diskGiB !== i.disk.diskGiB);
  const poolDiskGiB = i.disk && diskGiB !== null && diskGiB > i.disk.defaultGiB ? i.disk.defaultGiB : null;
  return { customized, name, settings: [sizeLabel, boxDiskLabel(diskGiB)].filter(Boolean).join(' · '), poolDiskGiB };
}

/** The new box is called by its own name, once anything about it was changed (and it has one). */
export function newBoxNamed(b: NewBoxSummary): boolean {
  return b.customized && !!b.name;
}

/** What the trigger and the New box choice say: the box's name once anything about it was changed, else "New box". */
export function newBoxTitle(b: NewBoxSummary): string {
  return newBoxNamed(b) ? b.name : 'New box';
}

/**
 * The lines of New box's tooltips: which box, its size and disk (what was picked, else the defaults), and
 * where it comes from: the warm pool when there is one, never for a disk bigger than the pool's boxes have.
 */
export function newBoxDetails(b: NewBoxSummary): string[] {
  const from = b.poolDiskGiB === null ? NEW_BOX_POOL : `Launched new: the warm pool's boxes have ${b.poolDiskGiB} GB disks`;
  return [newBoxNamed(b) ? `${b.name}, a new box` : 'A new box of its own', b.settings, from].filter(Boolean);
}

/**
 * The mark that says the box is still to be made: LaunchPad's sparkle, beside
 * the name, at the 20 px its artwork is drawn for (gotcha simple-ui-launchpad-controls). Named "New box" for a screen reader only where the text beside it
 * is the box's own name, so "New box" is never read twice.
 */
function NewBoxMark({ named }: { named: boolean }) {
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  return named
    ? <Icon name="sparkle" size="medium" className="chat-launch-new-mark" role="img" aria-label="New box" />
    : <Icon name="sparkle" size="medium" className="chat-launch-new-mark" aria-hidden="true" />;
}

/** A tooltip's lines, the first one bold, in LaunchPad's Tooltip with termag's colours. */
function TipLines({ lines }: { lines: readonly string[] }) {
  return <>{lines.map((l, i) => (i === 0 ? <strong key={i}>{l}</strong> : <span key={i}>{l}</span>))}</>;
}

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

export function LaunchDrawer({ boxes, boxChoice, onBoxChoice, wakingId, newBox, space, environment, checkout, schedule, newBoxName, newBoxSize, sessionName, disabled, boxLocked }: {
  boxes: readonly Instance[];
  boxChoice: string;
  onBoxChoice: (choice: string) => void;
  wakingId: string | null;
  /** The box New box makes (newBoxSummary), which its choice and the trigger name once it is changed. */
  newBox: NewBoxSummary;
  /** The space picker's trigger, which opens its own dialog. */
  space: React.ReactNode;
  /** The environment picker's trigger (EnvironmentSelect.tsx), which opens its own dialog, offered with no environment too. */
  environment?: React.ReactNode;
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
  // A changed new box goes by its name, marked new; what it gets is in the tooltip, never inline.
  const named = newBoxNamed(newBox);
  const details = newBoxDetails(newBox);
  return (
    <div className="chat-launch-drawer">
      <div className="chat-launch-strip">
        {/* LaunchPad's Tooltip on termag's own trigger button (Focusable), styled as the strip's other triggers. */}
        <TooltipTrigger delay={300}>
          <Focusable isDisabled={disabled}>
            <button
              type="button"
              className="chat-launch-trigger"
              aria-haspopup="dialog"
              aria-expanded={boxOpen}
              disabled={disabled}
              onClick={() => setBoxOpen(true)}
            >
              <BoxIcon />
              <span className="chat-launch-trigger-label">{chosen ? chosen.name : newBoxTitle(newBox)}</span>
              {!chosen && <NewBoxMark named={named} />}
            </button>
          </Focusable>
          <Tooltip placement="top" className={`${LP_THEME} chat-launch-tip`}>
            <TipLines lines={['Where this session runs', ...(chosen ? [`${chosen.name}: ${boxLine(chosen, wakingId === chosen.id)}`] : details)]} />
          </Tooltip>
        </TooltipTrigger>
        {space}
        {environment}
        {checkout}
        {schedule}
      </div>
      {boxOpen && createPortal(
        <Dialog title="Where this session runs" onClose={() => setBoxOpen(false)} className="chat-launch-dialog">
          <div className="chat-launch-boxes" role="radiogroup" aria-label="Box">
            {/* New box and its name are one choice: the name field opens inside it once picked.
                Marked new, so it never reads as one of the boxes under it; what it gets is in its tooltip. */}
            <div className="chat-launch-new" data-checked={boxChoice === NEW_BOX || undefined}>
              <TooltipTrigger delay={300}>
                <Focusable isDisabled={boxLocked}>
                  <LaunchChoice
                    checked={boxChoice === NEW_BOX}
                    mark={<NewBoxMark named={named} />}
                    name={newBoxTitle(newBox)}
                    disabled={boxLocked}
                    onClick={() => onBoxChoice(NEW_BOX)}
                  />
                </Focusable>
                <Tooltip placement="top" className={`${LP_THEME} chat-launch-tip`}><TipLines lines={details} /></Tooltip>
              </TooltipTrigger>
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
