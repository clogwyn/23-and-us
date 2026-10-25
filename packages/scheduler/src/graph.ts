/**
 * Graph preparation: validate the task tree and links, then reduce everything to
 * a DAG of leaf tasks. Summary tasks never carry their own dates — they are derived.
 *
 * Links on summaries are expanded to their leaf descendants. That is only exact for
 * the side of the summary that a link type reads, so we restrict:
 *   - summary as predecessor: FS or FF (driven by its finish = max of leaf finishes)
 *   - summary as successor:   FS or SS (constrains its start = every leaf's start)
 */
import { CONSTRAINT_TYPES, DEPENDENCY_TYPES } from "@reno/domain";
import type { SchedDependency, SchedTask, ScheduleError } from "./types.ts";

export interface Edge {
  from: string;
  to: string;
  type: SchedDependency["type"];
  lag: number;
}

export interface PreparedGraph {
  byId: Map<string, SchedTask>;
  children: Map<string, string[]>;
  leaves: string[]; // input order
  /** Leaf ids in topological order (deterministic: ties broken by input order). */
  order: string[];
  incoming: Map<string, Edge[]>;
  outgoing: Map<string, Edge[]>;
  /** Children-first order of summary ids, for roll-up. */
  summaryPostOrder: string[];
}

export function prepareGraph(
  tasks: readonly SchedTask[],
  deps: readonly SchedDependency[],
): { ok: true; graph: PreparedGraph } | { ok: false; errors: ScheduleError[] } {
  const errors: ScheduleError[] = [];
  const byId = new Map<string, SchedTask>();
  const position = new Map<string, number>();

  tasks.forEach((t, i) => {
    if (byId.has(t.id)) errors.push({ kind: "duplicate_task", taskId: t.id });
    byId.set(t.id, t);
    position.set(t.id, i);
  });

  // ── Tree ────────────────────────────────────────────────────────────────
  const children = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.parentId === null) continue;
    if (!byId.has(t.parentId)) {
      errors.push({ kind: "missing_parent", taskId: t.id, parentId: t.parentId });
      continue;
    }
    const list = children.get(t.parentId);
    if (list) list.push(t.id);
    else children.set(t.parentId, [t.id]);
  }

  const ancestorsOf = (id: string): string[] | null => {
    const seen: string[] = [];
    let cur = byId.get(id)?.parentId ?? null;
    while (cur !== null) {
      if (cur === id || seen.includes(cur)) return null; // cycle
      seen.push(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
    return seen;
  };

  const ancestors = new Map<string, Set<string>>();
  const reportedCycle = new Set<string>();
  for (const t of tasks) {
    const a = ancestorsOf(t.id);
    if (a === null) {
      if (!reportedCycle.has(t.id)) {
        const cyc = collectParentCycle(t.id, byId);
        cyc.forEach((c) => reportedCycle.add(c));
        errors.push({ kind: "parent_cycle", taskIds: cyc });
      }
    } else ancestors.set(t.id, new Set(a));
  }

  const isSummary = (id: string) => (children.get(id)?.length ?? 0) > 0;

  // ── Task field validation ───────────────────────────────────────────────
  for (const t of tasks) {
    if (isSummary(t.id)) continue;
    if (!Number.isInteger(t.durationDays) || t.durationDays < 0)
      errors.push({ kind: "invalid_task", taskId: t.id, reason: "Duration must be a whole number ≥ 0" });
    const ct = t.constraintType ?? "ASAP";
    if (!(CONSTRAINT_TYPES as readonly string[]).includes(ct))
      errors.push({ kind: "invalid_task", taskId: t.id, reason: `Unknown constraint ${ct}` });
    if (ct !== "ASAP" && !t.constraintDate)
      errors.push({ kind: "invalid_task", taskId: t.id, reason: `${ct} needs a constraint date` });
    if (t.actualStart && t.actualFinish && t.actualFinish < t.actualStart)
      errors.push({ kind: "invalid_task", taskId: t.id, reason: "Actual finish is before actual start" });
  }

  if (errors.length) return { ok: false, errors };

  // ── Leaf expansion ──────────────────────────────────────────────────────
  const leafMemo = new Map<string, string[]>();
  const leavesUnder = (id: string): string[] => {
    const hit = leafMemo.get(id);
    if (hit) return hit;
    const kids = children.get(id);
    const out = kids ? kids.flatMap(leavesUnder) : [id];
    leafMemo.set(id, out);
    return out;
  };

  const leaves = tasks.filter((t) => !isSummary(t.id)).map((t) => t.id);
  const incoming = new Map<string, Edge[]>(leaves.map((id) => [id, []]));
  const outgoing = new Map<string, Edge[]>(leaves.map((id) => [id, []]));

  for (const d of deps) {
    const { predecessorId: p, successorId: s } = d;
    if (!byId.has(p)) { errors.push({ kind: "unknown_task", taskId: p }); continue; }
    if (!byId.has(s)) { errors.push({ kind: "unknown_task", taskId: s }); continue; }
    const bad = (reason: string) => errors.push({ kind: "invalid_dependency", predecessorId: p, successorId: s, reason });

    if (p === s) { bad("A task can't depend on itself"); continue; }
    if (!(DEPENDENCY_TYPES as readonly string[]).includes(d.type)) { bad(`Unknown link type ${d.type}`); continue; }
    if (!Number.isInteger(d.lagDays)) { bad("Lag must be a whole number of days"); continue; }
    if (ancestors.get(s)?.has(p) || ancestors.get(p)?.has(s)) {
      bad("A task can't be linked to its own parent or child");
      continue;
    }
    if (isSummary(p) && (d.type === "SS" || d.type === "SF")) {
      bad(`A group can only lead with FS or FF (its finish), not ${d.type}`);
      continue;
    }
    if (isSummary(s) && (d.type === "FF" || d.type === "SF")) {
      bad(`A group can only follow with FS or SS (its start), not ${d.type}`);
      continue;
    }

    for (const from of leavesUnder(p))
      for (const to of leavesUnder(s)) {
        const e: Edge = { from, to, type: d.type, lag: d.lagDays };
        outgoing.get(from)?.push(e);
        incoming.get(to)?.push(e);
      }
  }
  if (errors.length) return { ok: false, errors };

  // ── Topological sort (Kahn, stable by input position) ──────────────────
  const indeg = new Map<string, number>(leaves.map((id) => [id, incoming.get(id)?.length ?? 0]));
  const ready = leaves.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  const byPos = (a: string, b: string) => (position.get(a) ?? 0) - (position.get(b) ?? 0);

  while (ready.length) {
    ready.sort(byPos);
    const id = ready.shift() as string;
    order.push(id);
    for (const e of outgoing.get(id) ?? []) {
      const n = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, n);
      if (n === 0) ready.push(e.to);
    }
  }

  if (order.length !== leaves.length) {
    const remaining = new Set(leaves.filter((id) => (indeg.get(id) ?? 0) > 0));
    return { ok: false, errors: [{ kind: "dependency_cycle", taskIds: findCycle(remaining, outgoing) }] };
  }

  // ── Summary roll-up order (children before parents) ────────────────────
  const summaryPostOrder: string[] = [];
  const visit = (id: string) => {
    for (const c of children.get(id) ?? []) visit(c);
    if (isSummary(id)) summaryPostOrder.push(id);
  };
  for (const t of tasks) if (t.parentId === null) visit(t.id);

  return { ok: true, graph: { byId, children, leaves, order, incoming, outgoing, summaryPostOrder } };
}

/** One concrete cycle among nodes that Kahn couldn't drain, as an ordered path. */
function findCycle(remaining: Set<string>, outgoing: Map<string, Edge[]>): string[] {
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const stack: string[] = [];
  let found: string[] = [];

  const dfs = (id: string): boolean => {
    state.set(id, 1);
    stack.push(id);
    for (const e of outgoing.get(id) ?? []) {
      if (!remaining.has(e.to)) continue;
      const s = state.get(e.to);
      if (s === 1) {
        found = stack.slice(stack.indexOf(e.to));
        return true;
      }
      if (s === undefined && dfs(e.to)) return true;
    }
    stack.pop();
    state.set(id, 2);
    return false;
  };

  for (const id of remaining) if (!state.has(id) && dfs(id)) break;
  return found;
}

function collectParentCycle(start: string, byId: Map<string, SchedTask>): string[] {
  const path: string[] = [];
  let cur: string | null = start;
  while (cur !== null && !path.includes(cur)) {
    path.push(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return cur === null ? path : path.slice(path.indexOf(cur));
}
