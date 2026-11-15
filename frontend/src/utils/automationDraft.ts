import { browserTimezone, cronToPreset, presetToCron, type PresetInput } from './automationSchedule';

/**
 * An automation's editable settings as a form holds them,
 * and the bodies the create and PATCH routes take for one. Pure, so the
 * classic UI (components/AutomationFields.tsx, pages/Automations.tsx,
 * NewProjectForm) and the simple UI share one meaning of a draft without
 * sharing components.
 */
export interface AutomationDraft {
  schedule: PresetInput;
  timezone: string;
  prompt: string;
  tier: 'full' | 'read';
  prOnChange: boolean;
  wakeBox: boolean;
  maxRunMinutes: number;
  keepRuns: number;
  enabled: boolean;
  /** A space the notes file is mirrored to between runs (decision 13); null = the box only. */
  spaceName: string | null;
  /** Post each finished run's report to the project's Slack channel. */
  notifySlack: boolean;
  /** Keyword alert: a run whose summary starts with this text, or matches the regex, pings alertTarget; empty is off. */
  alertPrefix: string;
  alertRegex: string;
  /** dm, project, or a Slack channel id. */
  alertTarget: string;
  /** Pauses, with their cause, and box trouble go to alertTarget. */
  healthAlerts: boolean;
}

/** What a draft is read from: an AutomationView, or anything shaped like one. */
export interface AutomationDraftSource {
  schedule: string; timezone: string; prompt: string; tier: string; prOnChange: boolean; wakeBox: boolean;
  maxRunMinutes: number; keepRuns: number; enabled: boolean; spaceName?: string | null; notifySlack?: boolean;
  alertPrefix?: string | null; alertRegex?: string | null; alertTarget?: string; healthAlerts?: boolean;
}

export function emptyDraft(): AutomationDraft {
  return {
    schedule: { preset: 'weekdays', time: '09:00', weekday: 1, cron: '' },
    timezone: browserTimezone(), prompt: '', tier: 'full', prOnChange: true, wakeBox: false, maxRunMinutes: 60, keepRuns: 20, enabled: true, spaceName: null, notifySlack: false,
    alertPrefix: '', alertRegex: '', alertTarget: 'dm', healthAlerts: true,
  };
}

export function draftFrom(a: AutomationDraftSource): AutomationDraft {
  return {
    schedule: cronToPreset(a.schedule), timezone: a.timezone, prompt: a.prompt, tier: a.tier === 'read' ? 'read' : 'full',
    prOnChange: a.prOnChange, wakeBox: a.wakeBox, maxRunMinutes: a.maxRunMinutes, keepRuns: a.keepRuns, enabled: a.enabled, spaceName: a.spaceName ?? null, notifySlack: a.notifySlack ?? false,
    alertPrefix: a.alertPrefix ?? '', alertRegex: a.alertRegex ?? '', alertTarget: a.alertTarget ?? 'dm', healthAlerts: a.healthAlerts ?? true,
  };
}

/** The cron a draft means, or null while its schedule fields are incomplete. */
export function draftCron(d: AutomationDraft): string | null {
  return presetToCron(d.schedule);
}

/** What the create and PATCH bodies carry for a draft. */
export function draftBody(d: AutomationDraft) {
  return {
    schedule: draftCron(d) ?? '', timezone: d.timezone, prompt: d.prompt, tier: d.tier, prOnChange: d.prOnChange,
    wakeBox: d.wakeBox, maxRunMinutes: d.maxRunMinutes, keepRuns: d.keepRuns, enabled: d.enabled, spaceName: d.spaceName, notifySlack: d.notifySlack,
    alertPrefix: d.alertPrefix.trim() || null, alertRegex: d.alertRegex.trim() || null, alertTarget: d.alertTarget, healthAlerts: d.healthAlerts,
  };
}
