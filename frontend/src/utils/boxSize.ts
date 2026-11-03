// Box sizes (backend services/boxSize.ts): what the New box pickers offer and
// how a box's size reads in the lists. The server sizes the box; GET
// /api/instances/sizes?repo= says whether there is anything to pick and what
// a box made for that repository would launch at (its .termag/environment.json, else
// the owner's default), so nothing here is a second copy of the size order.

import type { BoxDiskOptions } from './boxDisk';

export type BoxSize = 'small' | 'medium' | 'large';

/** The picker's entry for a repo default given as requirements (a type of its own, like r8g.xlarge). */
export const REPO_DEFAULT = 'repo';
export type SizePick = BoxSize | typeof REPO_DEFAULT;

export interface BoxSizeChoice {
  size: BoxSize;
  vcpus: number;
  memoryGiB: number;
  instanceType: string;
}

export interface BoxSizeOptions {
  /** Off while the owner's box-default-size is: no picker, and POST refuses a size. */
  enabled: boolean;
  /** The owner's box-default-size. */
  default: BoxSize | null;
  sizes: BoxSizeChoice[];
  /**
   * What a box with no size picked launches at for the repo asked about, which
   * the dropdowns preselect. Absent from an orchestrator before it, which
   * `default` stands in for.
   */
  defaultSize?: BoxSize | null;
  /** The repo's environment.json minimums, as EC2 matched them, when it asks for those rather than a preset. */
  defaultRequirements?: { vcpu: number; memoryGiB: number; instanceType: string } | null;
  /** What of the repo's environment.json the server left out, and why. */
  warnings?: string[];
  /** The New box disk field (utils/boxDisk.ts), whatever `enabled` says; absent from an orchestrator before it, null where it launches no boxes. */
  disk?: BoxDiskOptions | null;
}

/** The preselection for an orchestrator from before `default` too. */
const OLD_UI_DEFAULT: BoxSize = 'medium';

/**
 * What the New box dropdowns preselect: the server's answer for the repo, so
 * the dropdown shows what a box with nothing picked launches at. The repo
 * entry when the repo's environment.json asks for requirements.
 */
export function preselectedSize(options: BoxSizeOptions): SizePick {
  if (options.defaultRequirements) return REPO_DEFAULT;
  return options.defaultSize ?? options.default ?? OLD_UI_DEFAULT;
}

/**
 * The size a New box form sends: the person's pick of a preset; nothing for
 * the preselection or the repo entry, so the server sizes it by the same
 * order; nothing while there is no dropdown (sizes off).
 */
export function sizeToSend(options: BoxSizeOptions | null, picked: SizePick | null): BoxSize | undefined {
  if (!options || !picked || picked === REPO_DEFAULT) return undefined;
  return picked;
}

export function sizeName(size: string): string {
  return size.charAt(0).toUpperCase() + size.slice(1);
}

/** An option's two parts, from the server's size table: the name ("Medium") and its specs ("4 vCPU, 16 GB RAM"). */
export function sizeOptionParts(choice: Pick<BoxSizeChoice, 'size' | 'vcpus' | 'memoryGiB'>): { name: string; specs: string } {
  return { name: sizeName(choice.size), specs: `${choice.vcpus} vCPU, ${choice.memoryGiB} GB RAM` };
}

/** An option's label, the same in both UIs: "Medium · 4 vCPU, 16 GB RAM". */
export function sizeOptionLabel(choice: Pick<BoxSizeChoice, 'size' | 'vcpus' | 'memoryGiB'>): string {
  const { name, specs } = sizeOptionParts(choice);
  return `${name} · ${specs}`;
}

const REQUIREMENTS_RE = /^(\d+)vcpu-(\d+)gib$/;

/** A size recorded as a repo's requirements (`4vcpu-32gib`, backend services/boxRequirements.ts), not a preset. */
export function isRequirementsSize(size: string | null | undefined): boolean {
  return !!size && REQUIREMENTS_RE.test(size);
}

/**
 * A box's size in a line of text: a preset by its name, a box sized by its
 * repository's requirements (`4vcpu-32gib`) by the type it got, else by the
 * requirements ("4 vCPU, 32 GB"); null for no size.
 */
export function boxSizeName(size: string | null | undefined, instanceType: string | null | undefined): string | null {
  const req = size ? REQUIREMENTS_RE.exec(size) : null;
  if (req) return instanceType ?? `${req[1]} vCPU, ${req[2]} GB`;
  return size || null;
}

/**
 * A box's size in a list: its preset, with the type it launched as in the
 * tooltip; a box sized by a repo's requirements (`4vcpu-32gib`) by its type
 * alone; the type alone for a box launched with no size; null when neither
 * was recorded (older and external boxes).
 */
export function boxSizeBadge(size: string | null | undefined, instanceType: string | null | undefined): { label: string; title: string } | null {
  const req = size ? REQUIREMENTS_RE.exec(size) : null;
  if (req) {
    const wanted = `at least ${req[1]} vCPU, ${req[2]} GB RAM, from the repository's .termag/environment.json`;
    return { label: instanceType ?? size!, title: instanceType ? `${instanceType}: ${wanted}` : wanted };
  }
  if (size) return { label: size, title: instanceType ? `${size}: launched as ${instanceType}` : size };
  if (instanceType) return { label: instanceType, title: `launched as ${instanceType}, the orchestrator's configured type` };
  return null;
}
