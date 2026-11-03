// New session's schedule: none, one session that starts
// when the message is sent, or a schedule, an automation whose runs each take
// the message as their prompt. In the drawer it is a trigger like the box's
// and the space's (pages/chat/LaunchDrawer.tsx): a clock and the schedule in
// words, opening a dialog of the two choices drawn as the box dialog's cards.
// No schedule closes it; On a schedule opens the schedule's fields inside its
// card (components/AutomationFields.tsx, the prompt and the tier left to the
// composer) and waits for Done.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AutomationFields, type ScheduleCheck } from '../../components/AutomationFields';
import { draftCron, type AutomationDraft } from '../../utils/automationDraft';
import { Dialog } from '../../components/Dialog';
import { Tooltip } from '../../components/Tooltip';
import { describeSchedule } from '../../utils/automationSchedule';

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.9" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The trigger's words: No schedule, the schedule as its fields say it, or On a schedule while they are incomplete. */
export function scheduleLabel(scheduled: boolean, draft: AutomationDraft): string {
  if (!scheduled) return 'No schedule';
  const cron = draftCron(draft);
  if (!cron) return 'On a schedule';
  const words = describeSchedule(cron, '');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function SchedulePicker({ scheduled, onScheduledChange, draft, onDraftChange, check, tierElsewhere, disabled, onOpen }: {
  scheduled: boolean;
  onScheduledChange: (scheduled: boolean) => void;
  /** The automation's draft, its tier the permission pill's when tierElsewhere. */
  draft: AutomationDraft;
  onDraftChange: (next: AutomationDraft) => void;
  /** The page's useScheduleCheck, which keeps up while the dialog is closed. */
  check: ScheduleCheck;
  tierElsewhere: boolean;
  disabled?: boolean;
  /** The dialog is opening, so the page can close the repository and model menus. */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = scheduleLabel(scheduled, draft);
  const cron = draftCron(draft);
  // Only a schedule the server has refused, never one still being checked.
  const invalid = scheduled && (!!check.error || (check.preview?.tooFrequent ?? null) !== null);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  function show() {
    if (disabled) return;
    onOpen?.();
    setOpen(true);
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div className="chat-new-schedule">
      <Tooltip content={<><strong>When this runs</strong><span className="ui-tooltip-sub">{scheduled && cron ? `An automation, ${describeSchedule(cron, draft.timezone)}` : 'Once, when you send. A schedule makes it an automation'}</span></>}>
      <button
        ref={triggerRef}
        type="button"
        className="chat-launch-trigger chat-schedule-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Schedule, ${label}`}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={show}
      >
        <ClockIcon />
        <span className="chat-launch-trigger-label">{label}</span>
      </button>
      </Tooltip>
      {open && createPortal(
        <Dialog title="Schedule" onClose={close} className="chat-launch-dialog chat-schedule-dialog">
          <p className="chat-launch-dialog-note">
            On a schedule, the message is an automation's prompt: a fresh Claude runs it on a cadence, each run on its own branch and in its own conversation.
          </p>
          <div className="chat-launch-boxes" role="radiogroup" aria-label="Schedule">
            <button
              type="button"
              role="radio"
              aria-checked={!scheduled}
              className="chat-launch-box"
              onClick={() => { onScheduledChange(false); close(); }}
            >
              <span className="chat-launch-box-name">No schedule</span>
              <small>One session, starting when you send</small>
            </button>
            {/* On a schedule and its fields are one choice: the fields open inside it once picked. */}
            <div className="chat-launch-new" data-checked={scheduled || undefined}>
              <button
                type="button"
                role="radio"
                aria-checked={scheduled}
                className="chat-launch-box"
                onClick={() => onScheduledChange(true)}
              >
                <span className="chat-launch-box-name">On a schedule</span>
                <small>An automation that runs this prompt again and again</small>
              </button>
              {scheduled && (
                <div className="chat-launch-new-name chat-schedule-fields">
                  <AutomationFields
                    draft={draft}
                    onChange={onDraftChange}
                    check={check}
                    showPrompt={false}
                    tierElsewhere={tierElsewhere}
                    showEnabled
                    idPrefix="nc-af"
                  />
                </div>
              )}
            </div>
          </div>
          <div className="chat-launch-dialog-actions">
            <button type="button" className="btn-primary" onClick={close}>Done</button>
          </div>
        </Dialog>,
        document.body,
      )}
    </div>
  );
}
