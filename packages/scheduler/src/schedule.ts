/**
 * Critical Path Method on a leaf-task DAG.
 *
 * Time model: integer indices from the Calendar. A task with early start ES and
 * duration d occupies periods ES … ES+d−1; EF = ES+d is *exclusive*. Milestones
 * (d = 0) have EF = ES. Display dates convert back: finish = EF−1 (or ES for milestones).
 *
 * Link rules (successor S, predecessor P, lag L):
 *   FS  S.ES ≥ P.EF + L        SS  S.ES ≥ P.ES + L
 *   FF  S.EF ≥ P.EF + L        SF  S.EF ≥ P.ES + L
 *
 * State handling:
 *   complete    (actualFinish) — fixed history; ignores links; no float; never critical.
 *   in progress (actualStart)  — start fixed; finish ≥ status date; FF/SF links still apply.
 *   not started                — normal CPM, never before projectStart or statusDate.
 *
 * Constraints win over links (MS Project default); conflicts are reported as warnings.
 */
import type { DayDate } from "@reno/domain";
import { allDaysCalendar } from "./calendar.ts";
import { prepareGraph, type Edge } from "./graph.ts";
import type { ScheduleInput, ScheduleResult, ScheduleWarning, TaskSchedule, TaskState } from "./types.ts";

interface Node {
  es: number;
  ef: number;
  ls: number;
  lf: number;
  d: number;
  state: TaskState;
  pinned: boolean; // MSO / MFO
}

const lastDay = (es: number, ef: number) => (ef > es ? ef - 1 : es);

export function schedule(input: ScheduleInput): ScheduleResult {
  const cal = input.calendar ?? allDaysCalendar;
  const prepared = prepareGraph(input.tasks, input.dependencies);
  if (!prepared.ok) return prepared;
  const g = prepared.graph;

  const warnings: ScheduleWarning[] = [];
  const idx = (d: DayDate) => cal.toIndex(d);
  const date = (i: number) => cal.fromIndex(i);
  const startIdx = idx(input.projectStart);
  const statusIdx = input.statusDate ? idx(input.statusDate) : null;
  const floorIdx = statusIdx === null ? startIdx : Math.max(startIdx, statusIdx);

  for (const id of g.summaryPostOrder) {
    const t = g.byId.get(id);
    if (!t) continue;
    if ((t.constraintType ?? "ASAP") !== "ASAP") warnings.push({ kind: "summary_field_ignored", taskId: id, field: "constraint" });
    if (t.actualStart || t.actualFinish) warnings.push({ kind: "summary_field_ignored", taskId: id, field: "actuals" });
  }

  // Effective deadline per leaf = tightest of its own and every ancestor's.
  const effectiveDeadline = (id: string): number | null => {
    let best: number | null = null;
    let cur: string | null = id;
    while (cur !== null) {
      const t = g.byId.get(cur);
      if (!t) break;
      if (t.deadline) best = best === null ? idx(t.deadline) : Math.min(best, idx(t.deadline));
      cur = t.parentId;
    }
    return best;
  };

  // ── Forward pass ────────────────────────────────────────────────────────
  const nodes = new Map<string, Node>();
  const node = (id: string) => nodes.get(id) as Node;

  const requiredStart = (e: Edge, d: number): number => {
    const p = node(e.from);
    switch (e.type) {
      case "FS": return p.ef + e.lag;
      case "SS": return p.es + e.lag;
      case "FF": return p.ef + e.lag - d;
      case "SF": return p.es + e.lag - d;
    }
  };

  for (const id of g.order) {
    const t = g.byId.get(id);
    if (!t) continue;
    const d = t.durationDays;

    if (t.actualFinish) {
      const af = idx(t.actualFinish);
      const es = t.actualStart ? idx(t.actualStart) : af - Math.max(d - 1, 0);
      const ef = d === 0 && es === af ? af : af + 1;
      nodes.set(id, { es, ef, ls: es, lf: ef, d: ef - es, state: "complete", pinned: true });
      continue;
    }

    if (t.actualStart) {
      const es = idx(t.actualStart);
      let ef = es + d;
      for (const e of g.incoming.get(id) ?? []) {
        if (e.type === "FF" || e.type === "SF") ef = Math.max(ef, requiredStart(e, d) + d);
      }
      if (statusIdx !== null && d > 0 && ef <= statusIdx) {
        warnings.push({ kind: "overrun", taskId: id, plannedFinish: date(lastDay(es, ef)) });
        ef = statusIdx + 1; // still running, so it finishes today at the earliest
      }
      nodes.set(id, { es, ef, ls: 0, lf: 0, d: ef - es, state: "in_progress", pinned: false });
      continue;
    }

    let es = floorIdx;
    for (const e of g.incoming.get(id) ?? []) es = Math.max(es, requiredStart(e, d));

    const ct = t.constraintType ?? "ASAP";
    const c = t.constraintDate ? idx(t.constraintDate) : null;
    let pinned = false;
    if (c !== null) {
      const startForFinish = c - Math.max(d - 1, 0); // start that makes the last day land on c
      switch (ct) {
        case "SNET": es = Math.max(es, c); break;
        case "FNET": es = Math.max(es, startForFinish); break;
        case "MSO":
        case "MFO": {
          const target = ct === "MSO" ? c : startForFinish;
          if (es > target && t.constraintDate)
            warnings.push({ kind: "constraint_conflict", taskId: id, constraintType: ct, constraintDate: t.constraintDate, drivenStart: date(es) });
          es = target;
          pinned = true;
          break;
        }
        case "ASAP": break;
      }
    }
    nodes.set(id, { es, ef: es + d, ls: 0, lf: 0, d, state: "not_started", pinned });
  }

  // ── Project bounds ──────────────────────────────────────────────────────
  let projectEnd = startIdx; // exclusive
  let projectLastDay = startIdx; // inclusive, milestone-aware
  let projectFirst = Number.POSITIVE_INFINITY;
  for (const id of g.order) {
    const n = node(id);
    projectEnd = Math.max(projectEnd, n.ef);
    projectLastDay = Math.max(projectLastDay, lastDay(n.es, n.ef));
    projectFirst = Math.min(projectFirst, n.es);
  }
  if (!Number.isFinite(projectFirst)) projectFirst = startIdx;

  // Critical path is measured to the project end; a project deadline only tightens it.
  const projectDl = input.projectDeadline ? idx(input.projectDeadline) : null;
  if (input.projectDeadline) {
    const dl = idx(input.projectDeadline);
    if (projectLastDay > dl) {
      warnings.push({
        kind: "project_deadline_missed",
        deadline: input.projectDeadline,
        finish: date(projectLastDay),
        daysLate: projectLastDay - dl,
      });
    }
  }

  // ── Backward pass ───────────────────────────────────────────────────────
  const requiredFinish = (e: Edge, d: number): number | null => {
    const s = node(e.to);
    if (s.state === "complete") return null; // history imposes nothing
    if (s.state === "in_progress" && (e.type === "FS" || e.type === "SS")) return null; // its start has happened
    switch (e.type) {
      case "FS": return s.ls - e.lag;
      case "SS": return s.ls - e.lag + d;
      case "FF": return s.lf - e.lag;
      case "SF": return s.lf - e.lag + d;
    }
  };

  for (let i = g.order.length - 1; i >= 0; i--) {
    const id = g.order[i] as string;
    const n = node(id);
    if (n.state === "complete") continue;

    // Exclusive late-finish bound for a given last allowed day, milestone-aware.
    const byDay = (day: number) => day + (n.d > 0 ? 1 : 0);
    let lf = projectEnd;
    if (projectDl !== null) lf = Math.min(lf, byDay(projectDl));
    for (const e of g.outgoing.get(id) ?? []) {
      const r = requiredFinish(e, n.d);
      if (r !== null) lf = Math.min(lf, r);
    }
    const dl = effectiveDeadline(id);
    if (dl !== null) lf = Math.min(lf, byDay(dl));
    if (n.pinned) lf = Math.min(lf, n.ef); // can't move, so it has no slack to give
    n.lf = lf;
    n.ls = lf - n.d;
  }

  // ── Floats ──────────────────────────────────────────────────────────────
  const free = new Map<string, number | null>();
  for (const id of g.order) {
    const n = node(id);
    if (n.state === "complete") { free.set(id, null); continue; }
    let ff = projectEnd - n.ef;
    for (const e of g.outgoing.get(id) ?? []) {
      const s = node(e.to);
      if (s.state === "complete") continue;
      const slack =
        e.type === "FS" ? s.es - (n.ef + e.lag)
        : e.type === "SS" ? s.es - (n.es + e.lag)
        : e.type === "FF" ? s.ef - (n.ef + e.lag)
        : s.ef - (n.es + e.lag);
      ff = Math.min(ff, slack);
    }
    free.set(id, Math.max(ff, 0));
  }

  // ── Assemble leaves ─────────────────────────────────────────────────────
  const out = new Map<string, TaskSchedule>();
  const criticalPath: string[] = [];

  for (const id of g.order) {
    const n = node(id);
    const complete = n.state === "complete";
    const totalFloat = complete ? null : Math.min(n.lf - n.ef, n.ls - n.es);
    const isCritical = !complete && (totalFloat as number) <= 0;
    if (isCritical) criticalPath.push(id);

    out.set(id, {
      start: date(n.es),
      finish: date(lastDay(n.es, n.ef)),
      lateStart: date(n.ls),
      lateFinish: date(lastDay(n.ls, n.lf)),
      durationDays: n.d,
      totalFloat,
      freeFloat: free.get(id) ?? null,
      isCritical,
      isSummary: false,
      isMilestone: n.d === 0,
      state: n.state,
    });

    const t = g.byId.get(id);
    if (t?.deadline && !complete) {
      const dl = idx(t.deadline);
      const fin = lastDay(n.es, n.ef);
      if (fin > dl) warnings.push({ kind: "deadline_missed", taskId: id, deadline: t.deadline, finish: date(fin), daysLate: fin - dl });
    }
  }

  // ── Roll up summaries (children first) ──────────────────────────────────
  const span = new Map<string, { es: number; ef: number; ls: number; lf: number }>();
  for (const id of g.order) {
    const n = node(id);
    span.set(id, { es: n.es, ef: n.ef, ls: n.ls, lf: n.lf });
  }

  for (const id of g.summaryPostOrder) {
    const kids = g.children.get(id) ?? [];
    let es = Infinity, ef = -Infinity, ls = Infinity, lf = -Infinity;
    let tf: number | null = null;
    let ffl: number | null = null;
    let critical = false;
    const states = new Set<TaskState>();

    for (const k of kids) {
      const s = span.get(k);
      const r = out.get(k);
      if (!s || !r) continue;
      es = Math.min(es, s.es); ef = Math.max(ef, s.ef);
      ls = Math.min(ls, s.ls); lf = Math.max(lf, s.lf);
      if (r.totalFloat !== null) tf = tf === null ? r.totalFloat : Math.min(tf, r.totalFloat);
      if (r.freeFloat !== null) ffl = ffl === null ? r.freeFloat : Math.min(ffl, r.freeFloat);
      critical ||= r.isCritical;
      states.add(r.state);
    }

    const state: TaskState =
      states.size === 1 && states.has("complete") ? "complete"
      : states.has("in_progress") || states.has("complete") ? "in_progress"
      : "not_started";

    span.set(id, { es, ef, ls, lf });
    out.set(id, {
      start: date(es),
      finish: date(lastDay(es, ef)),
      lateStart: date(ls),
      lateFinish: date(lastDay(ls, lf)),
      durationDays: ef - es,
      totalFloat: tf,
      freeFloat: ffl,
      isCritical: critical,
      isSummary: true,
      isMilestone: false,
      state,
    });

    const t = g.byId.get(id);
    if (t?.deadline && state !== "complete") {
      const dl = idx(t.deadline);
      const fin = lastDay(es, ef);
      if (fin > dl) warnings.push({ kind: "deadline_missed", taskId: id, deadline: t.deadline, finish: date(fin), daysLate: fin - dl });
    }
  }

  return {
    ok: true,
    tasks: out,
    projectStart: date(Math.min(projectFirst, startIdx)),
    projectFinish: date(projectLastDay),
    criticalPath,
    warnings,
  };
}
