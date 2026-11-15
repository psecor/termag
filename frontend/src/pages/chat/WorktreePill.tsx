// Which code a New session gets, as a pill in its bar (chat-session-permissions-enabled):
// "Worktree of
// termag-22", a new branch of a checkout already on the box, or "New checkout",
// a fresh clone. A press switches between the two; which checkout, and where the
// worktree starts, stay under Options (CheckoutPicker). LaunchPad's Button and
// Tooltip, styled as the bar's pills and the drawer's tips are.
import React from 'react';
import { Button, Tooltip, TooltipTrigger } from '@launchpad-ui/components';
import { LP_THEME } from '../../launchpad/theme';

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

function CloneIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <rect x="2.5" y="4.5" width="8" height="9" rx="1.5" />
      <path d="M5.5 4.5V3.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-2" />
    </svg>
  );
}

/** The pill's words, and the tooltip's: what the session gets, and what a press switches it to. */
export function worktreePillWords(i: {
  /** The checkout a worktree session branches, or null for a new checkout. */
  worktree: string | null;
  /** The checkout a press would make it a worktree of. */
  target: string;
  /** What the code is: the project, or the repository picked. */
  of: string;
  /** Where the worktree starts: origin/<default> fetched now, or null for the checkout as it is. */
  fetchedFrom: string | null;
}): { label: string; lead: string; sub: string } {
  if (i.worktree) {
    return {
      label: `Worktree of ${i.worktree}`,
      lead: i.of === i.worktree ? `A worktree of ${i.worktree}` : `A worktree of ${i.worktree}, your checkout of ${i.of}`,
      sub: `A new branch from ${i.fetchedFrom ? `${i.fetchedFrom}, fetched now` : `${i.worktree}'s checkout`}, with no clone. Click for a new checkout instead.`,
    };
  }
  return {
    label: 'New checkout',
    lead: `A new checkout of ${i.of}`,
    sub: `A fresh clone, as a checkout of its own. Click to make it a worktree of ${i.target} instead.`,
  };
}

export function WorktreePill({ worktree, target, of, fetchedFrom, onSwitch, disabled }: {
  worktree: string | null;
  target: string;
  of: string;
  fetchedFrom: string | null;
  onSwitch: () => void;
  disabled?: boolean;
}) {
  const words = worktreePillWords({ worktree, target, of, fetchedFrom });
  return (
    <TooltipTrigger delay={300}>
      <Button
        variant="minimal"
        // Its own lp-theme: the chat root carries one only under the chrome refresh.
        className={`${LP_THEME} chat-compose-model-btn chat-worktree-btn`}
        data-choice={worktree ? 'worktree' : 'checkout'}
        aria-label={`Checkout: ${words.label}. Switch to ${worktree ? 'a new checkout' : `a worktree of ${target}`}`}
        isDisabled={disabled}
        onPress={onSwitch}
      >
        {worktree ? <BranchIcon /> : <CloneIcon />}
        <span className="chat-compose-pill-label">{words.label}</span>
      </Button>
      {/* Its overlay is portaled, so it carries the theme itself (as LaunchDrawer's tips do). */}
      <Tooltip placement="top" className={`${LP_THEME} chat-launch-tip`}>
        <strong>{words.lead}</strong>
        <span>{words.sub}</span>
      </Tooltip>
    </TooltipTrigger>
  );
}
