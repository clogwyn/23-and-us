"use client";
/** Editing operations shared by every view. Each goes through store.commit, so the engine validates it. */
import { fromEpochDay, parsePredecessorCode, sortBetween, toEpochDay, type DayDate } from "@23andus/domain";
import type { ProjectStore } from "./store";
import type { Status, Task, WState } from "./types";
import { fmtLong } from "./format";

const uuid = () => crypto.randomUUID();
const ep = (d: string) => toEpochDay(d as DayDate);
export const siblingsOf = (s: WState, parentId: string | null) =>
  s.tasks.filter((t) => t.parentId === parentId).sort((a, b) => a.sort - b.sort);

/** Status also records when work actually started and finished. */
export function applyStatus(store: ProjectStore, task: Task, status: Status): undefined {
  const s = store.sched(task.id);
  task.status = status;
  if (status === "todo" || status === "blocked" || status === "cancelled") {
    task.actualStart = null;
    task.actualFinish = null;
  } else if (status === "in_progress") {
    task.actualStart = task.actualStart ?? s?.start ?? store.state.project.startDate;
    task.actualFinish = null;
  } else {
    task.actualStart = task.actualStart ?? s?.start ?? store.state.project.startDate;
    task.actualFinish = s && s.finish >= task.actualStart ? s.finish : task.actualStart;
  }
  return undefined;
}

export function setStatus(store: ProjectStore, id: string, status: Status) {
  return store.commit((s) => {
    const t = s.tasks.find((x) => x.id === id);
    if (!t) return "That task no longer exists.";
    return applyStatus(store, t, status);
  });
}

export function setPreds(store: ProjectStore, id: string, code: string) {
  return store.commit((s) => {
    const parsed = parsePredecessorCode(code);
    if (!parsed.ok) return parsed.error;
    const deps = [];
    for (const p of parsed.value) {
      const pred = store.derived.wbsToId.get(p.ref);
      if (!pred) return `There's no task ${p.ref}.`;
      if (pred === id) return "A task can't come after itself.";
      const existing = s.deps.find((d) => d.succ === id && d.pred === pred);
      deps.push({ id: existing?.id ?? uuid(), pred, succ: id, type: p.type, lag: p.lagDays });
    }
    s.deps = s.deps.filter((d) => d.succ !== id).concat(deps);
    return undefined;
  });
}

export function indent(store: ProjectStore, id: string, expand: (id: string) => void) {
  return store.commit((s) => {
    const t = s.tasks.find((x) => x.id === id);
    if (!t) return "That task no longer exists.";
    const sibs = siblingsOf(s, t.parentId);
    const above = sibs[sibs.findIndex((x) => x.id === id) - 1];
    if (!above) return "There's no task above at this level to put it under.";
    t.parentId = above.id;
    t.sort = (siblingsOf(s, above.id).at(-1)?.sort ?? 0) + 1024;
    expand(above.id);
    return undefined;
  });
}

export function outdent(store: ProjectStore, id: string) {
  return store.commit((s) => {
    const t = s.tasks.find((x) => x.id === id);
    if (!t) return "That task no longer exists.";
    if (!t.parentId) return "It's already at the top level.";
    const parent = s.tasks.find((x) => x.id === t.parentId) as Task;
    const sibs = siblingsOf(s, parent.parentId);
    const next = sibs[sibs.findIndex((x) => x.id === parent.id) + 1];
    t.parentId = parent.parentId;
    t.sort = sortBetween(parent.sort, next?.sort ?? null);
    return undefined;
  });
}

export function move(store: ProjectStore, id: string, dir: -1 | 1) {
  return store.commit((s) => {
    const t = s.tasks.find((x) => x.id === id);
    if (!t) return "That task no longer exists.";
    const sibs = siblingsOf(s, t.parentId);
    const other = sibs[sibs.findIndex((x) => x.id === id) + dir];
    if (!other) return dir < 0 ? "It's already first in its group." : "It's already last in its group.";
    [t.sort, other.sort] = [other.sort, t.sort];
    return undefined;
  });
}

export function addTask(store: ProjectStore, afterId: string | null): string | null {
  const id = uuid();
  const ok = store.commit((s) => {
    const sel = afterId ? s.tasks.find((x) => x.id === afterId) : undefined;
    const parentId = sel?.parentId ?? null;
    const sibs = siblingsOf(s, parentId);
    const next = sel ? sibs[sibs.findIndex((x) => x.id === sel.id) + 1] : undefined;
    s.tasks.push({
      id,
      parentId,
      sort: sel ? sortBetween(sel.sort, next?.sort ?? null) : (sibs.at(-1)?.sort ?? 0) + 1024,
      title: "New task",
      description: "",
      areaId: sel?.areaId ?? null,
      duration: 1,
      status: "todo",
      constraintType: "ASAP",
      constraintDate: null,
      deadline: null,
      actualStart: null,
      actualFinish: null,
    });
    return undefined;
  });
  return ok ? id : null;
}

export function removeTask(store: ProjectStore, id: string) {
  return store.commit((s) => {
    const doomed = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of s.tasks)
        if (t.parentId && doomed.has(t.parentId) && !doomed.has(t.id)) {
          doomed.add(t.id);
          grew = true;
        }
    }
    s.tasks = s.tasks.filter((t) => !doomed.has(t.id));
    s.deps = s.deps.filter((d) => !doomed.has(d.pred) && !doomed.has(d.succ));
    s.costs = s.costs.filter((c) => !c.taskId || !doomed.has(c.taskId));
    return undefined;
  });
}

/** Drop a row before/after another, or inside a group. */
export function dropRow(store: ProjectStore, id: string, targetId: string, zone: "before" | "into" | "after", expand: (id: string) => void) {
  return store.commit((s) => {
    const moved = s.tasks.find((t) => t.id === id);
    const target = s.tasks.find((t) => t.id === targetId);
    if (!moved || !target) return "That task no longer exists.";
    for (let cur: string | null = target.id; cur; cur = s.tasks.find((t) => t.id === cur)?.parentId ?? null)
      if (cur === id) return "A task can't go inside its own subtask.";
    if (zone === "into") {
      moved.parentId = target.id;
      moved.sort = (siblingsOf(s, target.id).filter((t) => t.id !== id).at(-1)?.sort ?? 0) + 1024;
      expand(target.id);
      return undefined;
    }
    const sibs = siblingsOf(s, target.parentId).filter((t) => t.id !== id);
    const i = sibs.findIndex((t) => t.id === target.id);
    moved.parentId = target.parentId;
    moved.sort =
      zone === "before" ? sortBetween(sibs[i - 1]?.sort ?? null, target.sort) : sortBetween(target.sort, sibs[i + 1]?.sort ?? null);
    return undefined;
  });
}

/** Move a task's start by `days` using the least constraint that achieves it. Returns a message for the user. */
export function moveStart(store: ProjectStore, id: string, days: number): string | null {
  const t = store.task(id);
  const s = store.sched(id);
  if (!t || !s) return null;
  const newStart = fromEpochDay(ep(s.start) + days);

  if (t.constraintType === "MSO" || t.constraintType === "MFO") {
    store.commit((n) => {
      const x = n.tasks.find((k) => k.id === id);
      if (!x?.constraintDate) return "That task no longer exists.";
      x.constraintDate = fromEpochDay(ep(x.constraintDate) + days);
      return undefined;
    });
    return null;
  }

  const asap = structuredClone(store.state);
  const ax = asap.tasks.find((k) => k.id === id);
  if (!ax) return null;
  ax.constraintType = "ASAP";
  ax.constraintDate = null;
  const ra = store.scheduleOf(asap);
  const driven = ra.ok ? ra.tasks.get(id)?.start : undefined;
  if (!driven) return null;

  if (newStart < driven) {
    const preds = store.state.deps
      .filter((d) => d.succ === id)
      .map((d) => store.task(d.pred)?.title)
      .filter(Boolean);
    return `${t.title} can't start before ${fmtLong(driven)}${
      preds.length ? `: it comes after ${preds.slice(0, 2).join(" and ")}` : driven === store.derived.statusDate ? " (today)" : " (the project start)"
    }.`;
  }
  const ok = store.commit((n) => {
    const x = n.tasks.find((k) => k.id === id);
    if (!x) return "That task no longer exists.";
    if (newStart === driven) {
      x.constraintType = "ASAP";
      x.constraintDate = null;
    } else {
      x.constraintType = "SNET";
      x.constraintDate = newStart;
    }
    return undefined;
  });
  return ok && newStart !== driven ? `${t.title} now starts no earlier than ${fmtLong(newStart)}.` : null;
}

export function resize(store: ProjectStore, id: string, days: number) {
  return store.commit((s) => {
    const x = s.tasks.find((k) => k.id === id);
    if (!x) return "That task no longer exists.";
    x.duration = Math.max(1, x.duration + days);
    return undefined;
  });
}

export const newCostId = uuid;
