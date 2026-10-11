// Mirror of backend `services/statusKey.ts`.
export function statusKey(instanceId: string | null | undefined, session: string): string {
  return `${instanceId ?? ''}|${session}`;
}
