// The small chip an automation's row and page show: On, Off, Paused or
// Archived (chat/automationsView.ts automationState), and a run's state in
// its history (pending and running read as live).
import React from 'react';
import type { AutomationView } from '../../../services/api';
import { automationState } from '../../../chat/automationsView';

export function StateChip({ automation }: { automation: Pick<AutomationView, 'enabled' | 'pausedReason' | 'archived'> }) {
  const s = automationState(automation);
  return <span className="chat-auto-state" data-tone={s.tone} title={s.title}>{s.label}</span>;
}

export function RunStateChip({ state, label }: { state: string; label: string }) {
  return <span className="chat-auto-run-state" data-state={state} title={label}>{label}</span>;
}
