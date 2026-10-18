import { isValidBoxName } from './boxNames';

// Server sentences. Project names: routes/projects.ts and routes/projectNames.ts.
// Box names: routes/instances.ts createBox. Kept here so the form can refuse
// before it provisions a box the project route would reject.
export const PROJECT_NAME_ERROR = 'name must be alphanumeric with dashes/underscores only';
export const RESERVED_PROJECT_NAME_ERROR = '"MetaTerm" is a reserved project name';

const PROJECT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Empty when the trimmed name is one the project route accepts. */
export function projectNameError(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (!PROJECT_NAME_RE.test(trimmed)) return PROJECT_NAME_ERROR;
  if (trimmed.toLowerCase() === 'metaterm') return RESERVED_PROJECT_NAME_ERROR;
  return '';
}

/**
 * Box name derived from the project name. The two share [A-Za-z0-9_-], so a
 * valid project name is used unchanged. Anything else is reduced to that
 * charset; an empty result is not a usable box name.
 */
export function boxNameFromProject(projectName: string): string {
  const trimmed = projectName.trim();
  if (isValidBoxName(trimmed)) return trimmed;
  return trimmed.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

export interface NamedBox {
  name: string;
  status: string;
  kind: string;
}

/**
 * An active box that blocks a new launch under this name. A failed EC2 box
 * does not: createBox retires it and launches again under the same name.
 * The form shows the conflict and does not invent a suffixed name.
 */
export function boxNameTaken<T extends NamedBox>(name: string, boxes: readonly T[]): T | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  return boxes.find(box =>
    box.name === trimmed
    && box.status !== 'terminated'
    && !(box.kind === 'ec2' && box.status === 'failed'),
  );
}

export function boxNameConflictMessage(name: string): string {
  return `A box named "${name}" already exists`;
}
