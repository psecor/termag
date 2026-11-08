// Act as an orchestrator, as a switch in New session's bar beside the
// permissions (chat/newChat.ts orchestratorOption): its name and a small
// on/off track, so it reads as a toggle rather than a menu. It needs Full
// access, so while the session is read-only it stays off, dimmed, and says why
// on hover: it never grants commands by itself. On a box with termag
// setup off it is off the same way: there is no skill to use.
import React from 'react';
import { Tooltip } from '../components/Tooltip';
import { SETUP_OFF_TOOLTIP } from '../utils/boxSetup';

export type OrchestratorState = 'needs-trust' | 'setup-off' | 'available';

function HubIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="8.6" r="2.1" />
      <circle cx="8" cy="2.4" r="1.4" />
      <circle cx="2.6" cy="12.6" r="1.4" />
      <circle cx="13.4" cy="12.6" r="1.4" />
      <path d="M8 3.8v2.7M6.2 9.9l-2.4 1.8M9.8 9.9l2.4 1.8" strokeLinecap="round" />
    </svg>
  );
}

const ABOUT = 'Claude starts with the agent-orchestrator skill: it splits the work into tasks, hands them to other agents '
  + 'with termag ask, keeps plans and handoffs in a termag space, and combines what comes back instead of doing the work itself.';

/** The tooltip's first line: what the switch does, or why it can't yet. */
export function orchestratorLead(on: boolean, state: OrchestratorState): string {
  if (state === 'needs-trust') return 'Needs Full access: a read-only session cannot run commands';
  if (state === 'setup-off') return SETUP_OFF_TOOLTIP;
  return on ? 'On for this session' : 'Act as an orchestrator';
}

export const ORCHESTRATOR_ABOUT = ABOUT;

export function OrchestratorToggle({ on, onChange, state, disabled }: {
  on: boolean;
  onChange: (on: boolean) => void;
  state: OrchestratorState;
  disabled?: boolean;
}) {
  const unavailable = state !== 'available';
  const pressed = on && !unavailable;
  return (
    <Tooltip content={state === 'setup-off' ? orchestratorLead(pressed, state) : <><strong>{orchestratorLead(pressed, state)}</strong><span className="ui-tooltip-sub">{ABOUT}</span></>}>
    <button
      type="button"
      className="chat-compose-model-btn chat-orchestrator-btn"
      role="switch"
      aria-checked={pressed}
      // aria-disabled, not disabled, while it is unavailable: a disabled button gets no hover, so no tooltip.
      aria-disabled={unavailable || undefined}
      disabled={disabled}
      onClick={() => { if (!unavailable) onChange(!on); }}
    >
      <HubIcon />
      <span>Orchestrator</span>
      <span className="chat-switch" aria-hidden="true"><i /></span>
    </button>
    </Tooltip>
  );
}
