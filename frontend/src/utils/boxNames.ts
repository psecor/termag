// Mirror of backend/src/services/boxNames.ts: the server enforces it on create
// and rename, this lets the form say so before the request.
const BOX_NAME_RE = /^[A-Za-z0-9_-]+$/;

export const BOX_NAME_ERROR = 'Box names may contain only letters, digits, - and _';

export function isValidBoxName(name: string): boolean {
  return BOX_NAME_RE.test(name);
}
