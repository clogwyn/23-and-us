/**
 * Row ⇄ state mapping and the save step. A commit produces a new WState; save()
 * diffs it against the previous one and issues the minimal inserts/updates/deletes,
 * in an order that never trips the database's foreign keys or loop guard.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConstraintType, DependencyType } from "@23andus/domain";
import type { CostLine, Dep, Project, Status, Task, WState } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any -- database rows are untyped until types are generated */
export const toTask = (r: any): Task => ({
  id: r.id,
  parentId: r.parent_id,
  sort: Number(r.sort),
  title: r.title,
  description: r.description ?? "",
  areaId: r.area_id,
  duration: r.duration_days,
  status: r.status as Status,
  constraintType: r.constraint_type as ConstraintType,
  constraintDate: r.constraint_date,
  deadline: r.deadline,
  actualStart: r.actual_start,
  actualFinish: r.actual_finish,
});
export const toDep = (r: any): Dep => ({ id: r.id, pred: r.predecessor_id, succ: r.successor_id, type: r.type as DependencyType, lag: r.lag_days });
export const toCost = (r: any): CostLine => ({
  id: r.id,
  taskId: r.task_id,
  categoryId: r.category_id,
  description: r.description,
  estimate: r.estimate_pence === null ? null : Number(r.estimate_pence),
  actual: r.actual_pence === null ? null : Number(r.actual_pence),
  supplier: r.supplier_text ?? "",
});
export const toProject = (r: any): Project => ({
  id: r.id,
  householdId: r.household_id,
  name: r.name,
  startDate: r.start_date,
  deadline: r.deadline,
  budget: r.budget_pence === null ? null : Number(r.budget_pence),
  contingencyPct: Number(r.contingency_pct),
});
/* eslint-enable @typescript-eslint/no-explicit-any */

const TASK_COLS: Record<keyof Omit<Task, "id">, string> = {
  parentId: "parent_id",
  sort: "sort",
  title: "title",
  description: "description",
  areaId: "area_id",
  duration: "duration_days",
  status: "status",
  constraintType: "constraint_type",
  constraintDate: "constraint_date",
  deadline: "deadline",
  actualStart: "actual_start",
  actualFinish: "actual_finish",
};
const COST_COLS: Record<keyof Omit<CostLine, "id">, string> = {
  taskId: "task_id",
  categoryId: "category_id",
  description: "description",
  estimate: "estimate_pence",
  actual: "actual_pence",
  supplier: "supplier_text",
};
const PROJECT_COLS: Partial<Record<keyof Project, string>> = {
  name: "name",
  startDate: "start_date",
  deadline: "deadline",
  budget: "budget_pence",
  contingencyPct: "contingency_pct",
};

function changed<T extends { id: string }>(a: T, b: T, cols: Record<string, string>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(cols)) {
    const av = (a as Record<string, unknown>)[k];
    const bv = (b as Record<string, unknown>)[k];
    if (av !== bv) out[col] = bv;
  }
  return Object.keys(out).length ? out : null;
}
const row = <T extends { id: string }>(x: T, cols: Record<string, string>) => {
  const out: Record<string, unknown> = { id: x.id };
  for (const [k, col] of Object.entries(cols)) out[col] = (x as Record<string, unknown>)[k];
  return out;
};

async function run(label: string, p: PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await p;
  if (error) throw new Error(`${label}: ${error.message}`);
}

export async function save(sb: SupabaseClient, prev: WState, next: WState): Promise<void> {
  const base = { household_id: next.project.householdId, project_id: next.project.id };

  // Project
  const pc: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(PROJECT_COLS)) {
    const key = k as keyof Project;
    if (prev.project[key] !== next.project[key]) pc[col as string] = next.project[key];
  }
  if (Object.keys(pc).length) await run("Saving the project", sb.from("projects").update(pc).eq("id", next.project.id));

  // Tasks: inserts parents-first, then updates
  const prevT = new Map(prev.tasks.map((t) => [t.id, t]));
  const nextT = new Map(next.tasks.map((t) => [t.id, t]));
  const depth = (t: Task): number => (t.parentId && nextT.get(t.parentId) && !prevT.has(t.parentId) ? 1 + depth(nextT.get(t.parentId) as Task) : 0);
  const inserted = next.tasks.filter((t) => !prevT.has(t.id)).sort((a, b) => depth(a) - depth(b));
  for (const t of inserted) await run("Adding a task", sb.from("tasks").insert({ ...row(t, TASK_COLS), ...base }));
  for (const t of next.tasks) {
    const before = prevT.get(t.id);
    const diff = before && changed(before, t, TASK_COLS);
    if (diff) await run("Saving a task", sb.from("tasks").update(diff).eq("id", t.id));
  }

  // Dependencies: removals first so a reversed link doesn't look like a loop
  const prevD = new Map(prev.deps.map((d) => [d.id, d]));
  const nextD = new Map(next.deps.map((d) => [d.id, d]));
  const goneDeps = prev.deps.filter((d) => !nextD.has(d.id)).map((d) => d.id);
  if (goneDeps.length) await run("Removing links", sb.from("task_dependencies").delete().in("id", goneDeps));
  for (const d of next.deps) {
    const before = prevD.get(d.id);
    const r = { predecessor_id: d.pred, successor_id: d.succ, type: d.type, lag_days: d.lag };
    if (!before) await run("Adding a link", sb.from("task_dependencies").insert({ id: d.id, ...r, ...base }));
    else if (before.pred !== d.pred || before.succ !== d.succ || before.type !== d.type || before.lag !== d.lag)
      await run("Saving a link", sb.from("task_dependencies").update(r).eq("id", d.id));
  }

  // Costs removed in this change, deleted explicitly *before* their task: the database would
  // otherwise keep a deleted task's costs as unassigned project costs (task_id set null).
  const prevC = new Map(prev.costs.map((c) => [c.id, c]));
  const nextC = new Map(next.costs.map((c) => [c.id, c]));
  const goneCosts = prev.costs.filter((c) => !nextC.has(c.id)).map((c) => c.id);
  if (goneCosts.length) await run("Deleting costs", sb.from("cost_lines").delete().in("id", goneCosts));

  // Task deletions (subtasks and links cascade in the database)
  const goneTasks = prev.tasks.filter((t) => !nextT.has(t.id)).map((t) => t.id);
  if (goneTasks.length) await run("Deleting tasks", sb.from("tasks").delete().in("id", goneTasks));

  // Cost inserts and updates
  for (const c of next.costs) {
    const before = prevC.get(c.id);
    if (!before) await run("Adding a cost", sb.from("cost_lines").insert({ ...row(c, COST_COLS), ...base }));
    else {
      const diff = changed(before, c, COST_COLS);
      if (diff) await run("Saving a cost", sb.from("cost_lines").update(diff).eq("id", c.id));
    }
  }
}

export async function load(sb: SupabaseClient, projectId: string): Promise<WState> {
  const [p, t, d, c] = await Promise.all([
    sb.from("projects").select("*").eq("id", projectId).single(),
    sb.from("tasks").select("*").eq("project_id", projectId),
    sb.from("task_dependencies").select("*").eq("project_id", projectId),
    sb.from("cost_lines").select("*").eq("project_id", projectId),
  ]);
  for (const r of [p, t, d, c]) if (r.error) throw new Error(r.error.message);
  return {
    project: toProject(p.data),
    tasks: (t.data ?? []).map(toTask),
    deps: (d.data ?? []).map(toDep),
    costs: (c.data ?? []).map(toCost),
  };
}
