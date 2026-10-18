/**
 * Which box a box inherits its spaces from.
 *
 * The parent is derived, never stored: today the only derived box is the one
 * an ask spins up for its thread, and its parent is the box whose token opened
 * the thread. That link (AgentThread and its first AgentMessage's
 * senderInstanceId, #302/#307) is not on main yet, so parentBoxOf answers no
 * parent for every box and inheritance is inert. When it lands, it is one case
 * in parentBoxOf plus the rows the store loads for it; spaceAccess and the
 * Members tab already walk whatever this returns.
 *
 * Pure: the caller loads the rows.
 */

export const MAX_INHERITANCE_HOPS = 8;

export interface InheritanceBox {
  id: string;
  userId: string | null;
  status: string;
}

/** The rows parentBoxOf reads. Empty until the ask thread link exists. */
export type InheritanceRows = Record<string, never>;

export function parentBoxOf(_box: InheritanceBox, _rows: InheritanceRows): string | null {
  return null;
}

/** The boxes whose parent is `parentId`, among `boxes`. */
export function childBoxesOf<B extends InheritanceBox>(parentId: string, boxes: readonly B[], rows: InheritanceRows): B[] {
  return boxes.filter(b => b.id !== parentId && parentBoxOf(b, rows) === parentId);
}

/**
 * The box's ancestors, nearest first, at most MAX_INHERITANCE_HOPS. The walk
 * stops at a missing, terminated or differently-owned parent: none of those
 * passes access on, and nothing above it can either.
 */
export async function ancestorsOf(
  box: InheritanceBox,
  loadBox: (id: string) => Promise<InheritanceBox | null>,
  rows: InheritanceRows,
): Promise<InheritanceBox[]> {
  const out: InheritanceBox[] = [];
  const seen = new Set([box.id]);
  let current = box;
  while (out.length < MAX_INHERITANCE_HOPS) {
    const parentId = parentBoxOf(current, rows);
    if (!parentId || seen.has(parentId)) break;
    const parent = await loadBox(parentId);
    if (!parent || parent.status === 'terminated' || parent.userId !== box.userId) break;
    out.push(parent);
    seen.add(parent.id);
    current = parent;
  }
  return out;
}
