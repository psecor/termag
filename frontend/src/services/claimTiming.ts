import { instancesApi } from './api';

// Click-to-first-terminal-data for a claimed box, which is the number the warm
// pool is judged on. It spans three components and two navigations, so the
// stopwatch lives here rather than in any of their state. One claim is in
// flight at a time, so a new click abandons whatever the last one was tracking.

let clickedAt: number | null = null;
let pickerMountedAt: number | null = null;
const claimClickByInstance = new Map<string, number>();
const instanceByProject = new Map<string, string>();
const pickMsByInstance = new Map<string, number>();

export function notePickerMounted(): void {
  pickerMountedAt = performance.now();
}

export function notePickerSubmitted(instanceId: string): void {
  if (pickerMountedAt === null) return;
  pickMsByInstance.set(instanceId, Math.round(performance.now() - pickerMountedAt));
}

export function noteAddBoxClick(): void {
  clickedAt = performance.now();
  claimClickByInstance.clear();
  instanceByProject.clear();
}

export function noteBoxClaimed(instanceId: string): void {
  if (clickedAt === null) return;
  claimClickByInstance.set(instanceId, clickedAt);
  clickedAt = null;
}

export function noteProjectCreated(projectId: string, instanceId: string): void {
  if (!claimClickByInstance.has(instanceId)) return;
  instanceByProject.set(projectId, instanceId);
}

export function noteFirstTerminalData(projectId: string): void {
  const instanceId = instanceByProject.get(projectId);
  if (instanceId === undefined) return;
  const startedAt = claimClickByInstance.get(instanceId);
  instanceByProject.delete(projectId);
  if (startedAt === undefined) return;
  claimClickByInstance.delete(instanceId);
  const pickMs = pickMsByInstance.get(instanceId);
  pickMsByInstance.delete(instanceId);
  instancesApi.claimTiming(instanceId, Math.round(performance.now() - startedAt), pickMs ?? null).catch(() => {});
}
