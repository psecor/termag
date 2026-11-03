// Test fixtures for the simple UI's automations (automationsView, useAutomation, pages/chat/automations).
import type { AutomationRunView, AutomationView } from '../services/api';

export function automation(over: Partial<AutomationView> = {}): AutomationView {
  return {
    id: 'a1', projectId: 'p1', projectName: 'triage', instanceId: 'box1', repoUrl: null, defaultBranch: null,
    schedule: '0 9 * * 1-5', timezone: 'UTC', prompt: 'look at the queue', tier: 'read', enabled: true, prOnChange: false,
    wakeBox: false, maxRunMinutes: 30, keepRuns: 10, spaceName: null, notifySlack: false, pausedReason: null,
    consecutiveFailures: 0, nextRunAt: null, next: [], lastRun: null, createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z', owner: true, archived: false, ...over,
  };
}

export function run(over: Partial<AutomationRunView> = {}): AutomationRunView {
  return {
    id: 'r1', automationId: 'a1', trigger: 'schedule', scheduledFor: '2026-10-26T09:00:00Z', state: 'done', reason: null,
    reasonLabel: null, workstreamId: 'w1', workstream: 'run-1', instanceId: 'box1', chatSessionId: null, summary: null,
    branch: null, prUrl: null, costUsd: null, inputTokens: null, outputTokens: null, commitsAhead: null, pushed: null,
    dirty: null, changesLabel: null, reportedAt: null, startedAt: null, finishedAt: null, retiredAt: null,
    createdAt: '2026-10-26T09:00:00Z', durationSec: null, ...over,
  };
}
