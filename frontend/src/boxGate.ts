export type BoxGateState = 'off' | 'clear' | 'blocked';

export const CONNECT_GITHUB_TO_ADD_BOX = 'Connect GitHub in Settings to add a box';

export function blocksManagedBox(state: BoxGateState | undefined): boolean {
  return state === 'blocked';
}

export function gateArmed(state: BoxGateState | undefined): boolean {
  return state === 'clear' || state === 'blocked';
}
