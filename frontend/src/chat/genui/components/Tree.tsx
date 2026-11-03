// A hierarchy to look at (a file tree, a project's workstreams), drawn with
// LaunchPad's Tree: display only, no selection. LaunchPad's TreeItemContent
// draws each branch's expand/collapse chevron (an Icon in a Button React Aria
// labels "Expand"/"Collapse"), and the arrow keys move and expand.
import React from 'react';
import { Tree, TreeItem, TreeItemContent } from '@launchpad-ui/components';
import { z } from 'zod';
import { defineGenUiComponent } from './index';
import './Tree.css';

export const TREE_MAX_NODES = 200;
export const TREE_MAX_DEPTH = 6;

export interface TreeNode { id: string; label: string; detail?: string; children?: TreeNode[] }

const id = z.string().min(1).max(100);
// Recursive through z.lazy, not a getter: json-render's prompt writer walks a
// schema with no cycle check and stops only at a lazy (it prints that level's
// children as Array<unknown>; the description says they are nodes too).
const node: z.ZodType<TreeNode> = z.object({
  id,
  label: z.string().min(1).max(200),
  detail: z.string().max(100).optional(),
  children: z.array(z.lazy(() => node)).max(TREE_MAX_NODES).optional(),
});

/** How many nodes a tree has, how many levels deep it goes (top level is 1), and the first id seen twice. */
export function measureTree(items: TreeNode[]): { nodes: number; depth: number; repeated: string | null } {
  let nodes = 0;
  let depth = 0;
  let repeated: string | null = null;
  const seen = new Set<string>();
  const stack: Array<[TreeNode, number]> = items.map(n => [n, 1]);
  while (stack.length) {
    const [n, level] = stack.pop()!;
    nodes++;
    depth = Math.max(depth, level);
    if (seen.has(n.id)) repeated ??= n.id;
    seen.add(n.id);
    for (const c of n.children ?? []) stack.push([c, level + 1]);
  }
  return { nodes, depth, repeated };
}

const props = z.object({
  label: z.string().min(1).max(200),
  items: z.array(node).min(1).max(TREE_MAX_NODES),
  defaultExpanded: z.union([z.enum(['all', 'none']), z.array(id).max(TREE_MAX_NODES)]).optional(),
  code: z.boolean().optional(),
})
  .refine(p => measureTree(p.items).nodes <= TREE_MAX_NODES, { message: `at most ${TREE_MAX_NODES} nodes in all`, path: ['items'] })
  .refine(p => measureTree(p.items).depth <= TREE_MAX_DEPTH, { message: `at most ${TREE_MAX_DEPTH} levels deep`, path: ['items'] })
  .refine(p => measureTree(p.items).repeated === null, { message: 'every node needs its own id', path: ['items'] });

type TreeProps = z.infer<typeof props>;

/** The ids to open first: every branch for "all", none for "none" (the default), else the ids given. */
function expandedKeys(items: TreeNode[], expanded: TreeProps['defaultExpanded']): string[] {
  if (Array.isArray(expanded)) return expanded;
  if (expanded !== 'all') return [];
  const ids: string[] = [];
  const stack = [...items];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.children?.length) { ids.push(n.id); stack.push(...n.children); }
  }
  return ids;
}

function TreeRow({ node: n }: { node: TreeNode }) {
  return (
    <TreeItem id={n.id} textValue={n.label} className="genui-tree-item">
      <TreeItemContent>
        <span className="genui-tree-label">{n.label}</span>
        {n.detail && <span className="genui-tree-detail">{n.detail}</span>}
      </TreeItemContent>
      {n.children?.map(c => <TreeRow key={c.id} node={c} />)}
    </TreeItem>
  );
}

export default defineGenUiComponent({
  name: 'Tree',
  props,
  description: 'A read-only hierarchy that expands and collapses: a file tree, a project\'s workstreams, an org chart. items are nodes { id, label, detail?, children? } where children are nodes of the same shape; ids unique, at most 200 nodes and 6 levels. detail is a short note at the row\'s end ("+12 −3", "new"). defaultExpanded is "all", "none" (the default: only the top level shows) or the ids of the nodes to open. code: true shows labels in monospace (file names, paths). label names the tree for screen readers. Use a List for a flat list, a Table when rows have several columns.',
  Component: ({ props: p }) => (
    <Tree aria-label={p.label} className={p.code ? 'genui-tree genui-tree-code' : 'genui-tree'} defaultExpandedKeys={expandedKeys(p.items, p.defaultExpanded)}>
      {p.items.map(n => <TreeRow key={n.id} node={n} />)}
    </Tree>
  ),
});
