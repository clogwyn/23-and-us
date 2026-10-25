/**
 * Task-tree utilities: ordering and WBS codes ("1", "1.2", "1.2.3").
 * Works on any node with id/parentId/sort so it serves tasks and areas alike.
 */
export interface TreeNode {
  id: string;
  parentId: string | null;
  sort: number;
}

export interface FlatRow<T extends TreeNode> {
  node: T;
  depth: number;
  wbs: string;
  hasChildren: boolean;
}

export function childrenIndex<T extends TreeNode>(nodes: readonly T[]): Map<string | null, T[]> {
  const byParent = new Map<string | null, T[]>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    // Orphans (parent missing) are treated as roots rather than lost.
    const key = n.parentId !== null && ids.has(n.parentId) ? n.parentId : null;
    const list = byParent.get(key);
    if (list) list.push(n);
    else byParent.set(key, [n]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
  return byParent;
}

/** Depth-first flattening in display order, with WBS codes. Guards against parent cycles. */
export function flattenTree<T extends TreeNode>(nodes: readonly T[]): FlatRow<T>[] {
  const byParent = childrenIndex(nodes);
  const out: FlatRow<T>[] = [];
  const visiting = new Set<string>();

  const walk = (parent: string | null, prefix: string, depth: number) => {
    const kids = byParent.get(parent) ?? [];
    kids.forEach((node, i) => {
      if (visiting.has(node.id)) throw new Error(`Parent cycle detected at ${node.id}`);
      visiting.add(node.id);
      const wbs = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      const hasChildren = (byParent.get(node.id)?.length ?? 0) > 0;
      out.push({ node, depth, wbs, hasChildren });
      walk(node.id, wbs, depth + 1);
      visiting.delete(node.id);
    });
  };
  walk(null, "", 0);

  if (out.length !== nodes.length) throw new Error("Parent cycle detected: some nodes are unreachable from a root");
  return out;
}

export function wbsMaps(nodes: readonly TreeNode[]): { idToWbs: Map<string, string>; wbsToId: Map<string, string> } {
  const idToWbs = new Map<string, string>();
  const wbsToId = new Map<string, string>();
  for (const row of flattenTree(nodes)) {
    idToWbs.set(row.node.id, row.wbs);
    wbsToId.set(row.wbs, row.node.id);
  }
  return { idToWbs, wbsToId };
}

/** Sort key between two neighbours, for drag-reorder without renumbering siblings. */
export function sortBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1024;
  if (before === null) return (after as number) - 1024;
  if (after === null) return before + 1024;
  return (before + after) / 2;
}
