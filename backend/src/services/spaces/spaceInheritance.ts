/**
 * Which box a box inherits its spaces from.
 *
 * A box's parent is Instance.parentInstanceId: the box whose credentials
 * created it through the CLI (`termag project create --new-box`, the ask-box
 * flow, warm-pool claims made that way). spaceAccess and the Members tab walk
 * whatever this returns; a child acts with its owner's role, like any box.
 *
 * Pure: the caller loads the rows.
 */

export const MAX_INHERITANCE_HOPS = 8;

export interface InheritanceBox {
  id: string;
  userId: string | null;
  status: string;
  parentInstanceId?: string | null;
}

export function parentBoxOf(box: InheritanceBox): string | null {
  return box.parentInstanceId ?? null;
}

/** The boxes whose parent is `parentId`, among `boxes`. */
export function childBoxesOf<B extends InheritanceBox>(parentId: string, boxes: readonly B[]): B[] {
  return boxes.filter(b => b.id !== parentId && parentBoxOf(b) === parentId);
}

/**
 * The box's ancestors, nearest first, at most MAX_INHERITANCE_HOPS. The walk
 * stops at a missing, terminated or differently-owned parent: none of those
 * passes access on, and nothing above it can either.
 */
export async function ancestorsOf(
  box: InheritanceBox,
  loadBox: (id: string) => Promise<InheritanceBox | null>,
): Promise<InheritanceBox[]> {
  const out: InheritanceBox[] = [];
  const seen = new Set([box.id]);
  let current = box;
  while (out.length < MAX_INHERITANCE_HOPS) {
    const parentId = parentBoxOf(current);
    if (!parentId || seen.has(parentId)) break;
    const parent = await loadBox(parentId);
    if (!parent || parent.status === 'terminated' || parent.userId !== box.userId) break;
    out.push(parent);
    seen.add(parent.id);
    current = parent;
  }
  return out;
}
