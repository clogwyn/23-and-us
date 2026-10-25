import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { dayDate, toEpochDay, type DayDate } from "@reno/domain";
import { schedule } from "./schedule.ts";
import { diffSchedules } from "./diff.ts";
import type { SchedDependency, SchedTask, ScheduleInput, ScheduleResult, TaskSchedule } from "./types.ts";

// Project starts Monday 2 Nov 2026. Hand-calculated expectations below use this anchor.
const START = dayDate("2026-11-02");
const D = (s: string) => dayDate(`2026-11-${s.padStart(2, "0")}`);

const t = (id: string, durationDays: number, extra: Partial<SchedTask> = {}): SchedTask => ({
  id,
  parentId: null,
  durationDays,
  ...extra,
});
const dep = (p: string, s: string, type: SchedDependency["type"] = "FS", lagDays = 0): SchedDependency => ({
  predecessorId: p,
  successorId: s,
  type,
  lagDays,
});

function run(tasks: SchedTask[], dependencies: SchedDependency[] = [], extra: Partial<ScheduleInput> = {}) {
  const r = schedule({ projectStart: START, tasks, dependencies, ...extra });
  if (!r.ok) throw new Error(`Expected ok, got ${JSON.stringify(r.errors)}`);
  return r;
}
const span = (r: Extract<ScheduleResult, { ok: true }>, id: string) => {
  const s = r.tasks.get(id) as TaskSchedule;
  return `${s.start}..${s.finish}`;
};

describe("forward/backward pass", () => {
  // A(3) ─┬─> B(2) ─┐
  //       └─> C(4) ─┴─> D(1)
  const net = () =>
    run([t("A", 3), t("B", 2), t("C", 4), t("D", 1)], [dep("A", "B"), dep("A", "C"), dep("B", "D"), dep("C", "D")]);

  it("computes early dates", () => {
    const r = net();
    expect(span(r, "A")).toBe(`${D("2")}..${D("4")}`);
    expect(span(r, "B")).toBe(`${D("5")}..${D("6")}`);
    expect(span(r, "C")).toBe(`${D("5")}..${D("8")}`);
    expect(span(r, "D")).toBe(`${D("9")}..${D("9")}`);
    expect(r.projectFinish).toBe(D("9"));
  });

  it("finds the critical path and float", () => {
    const r = net();
    expect(r.criticalPath).toEqual(["A", "C", "D"]);
    expect(r.tasks.get("B")).toMatchObject({ totalFloat: 2, freeFloat: 2, isCritical: false, lateStart: D("7"), lateFinish: D("8") });
    expect(r.tasks.get("C")).toMatchObject({ totalFloat: 0, isCritical: true });
  });
});

describe("link types and lag", () => {
  it("FS with lag and lead", () => {
    expect(span(run([t("A", 3), t("B", 2)], [dep("A", "B", "FS", 2)]), "B")).toBe(`${D("7")}..${D("8")}`);
    expect(span(run([t("A", 3), t("B", 2)], [dep("A", "B", "FS", -1)]), "B")).toBe(`${D("4")}..${D("5")}`);
  });

  it("SS+1", () => {
    expect(span(run([t("A", 5), t("B", 3)], [dep("A", "B", "SS", 1)]), "B")).toBe(`${D("3")}..${D("5")}`);
  });

  it("FF: successor finishes with predecessor", () => {
    expect(span(run([t("A", 5), t("B", 2)], [dep("A", "B", "FF")]), "B")).toBe(`${D("5")}..${D("6")}`);
  });

  it("SF+4: successor finishes 4 days after predecessor starts", () => {
    expect(span(run([t("A", 3), t("B", 2)], [dep("A", "B", "SF", 4)]), "B")).toBe(`${D("4")}..${D("5")}`);
  });

  it("never schedules before the project start, even with leads", () => {
    expect(span(run([t("A", 3), t("B", 2)], [dep("A", "B", "SS", -5)]), "B")).toBe(`${D("2")}..${D("3")}`);
  });
});

describe("milestones", () => {
  it("sits at the start of the day after its predecessor and passes through", () => {
    const r = run([t("A", 3), t("M", 0), t("B", 2)], [dep("A", "M"), dep("M", "B")]);
    expect(r.tasks.get("M")).toMatchObject({ start: D("5"), finish: D("5"), isMilestone: true, isCritical: true });
    expect(span(r, "B")).toBe(`${D("5")}..${D("6")}`);
  });

  it("an end milestone is the project finish", () => {
    const r = run([t("A", 3), t("M", 0)], [dep("A", "M")]);
    expect(r.projectFinish).toBe(D("5"));
  });
});

describe("constraints", () => {
  it("SNET pushes later", () => {
    const r = run([t("A", 3), t("B", 2, { constraintType: "SNET", constraintDate: D("10") })], [dep("A", "B")]);
    expect(span(r, "B")).toBe(`${D("10")}..${D("11")}`);
  });

  it("FNET aligns the last day", () => {
    const r = run([t("A", 3), t("B", 2, { constraintType: "FNET", constraintDate: D("12") })], [dep("A", "B")]);
    expect(span(r, "B")).toBe(`${D("11")}..${D("12")}`);
  });

  it("MSO wins over links and warns", () => {
    const r = run([t("A", 3), t("B", 2, { constraintType: "MSO", constraintDate: D("3") })], [dep("A", "B")]);
    expect(span(r, "B")).toBe(`${D("3")}..${D("4")}`);
    expect(r.warnings).toContainEqual(expect.objectContaining({ kind: "constraint_conflict", taskId: "B", drivenStart: D("5") }));
    expect(r.tasks.get("B")?.isCritical).toBe(true);
  });

  it("MFO pins the finish", () => {
    const r = run([t("A", 3, { constraintType: "MFO", constraintDate: D("20") })]);
    expect(span(r, "A")).toBe(`${D("18")}..${D("20")}`);
  });
});

describe("progress", () => {
  it("complete tasks are fixed history, successors respect the status date", () => {
    const r = run(
      [t("A", 3, { actualStart: D("2"), actualFinish: D("5") }), t("B", 2)],
      [dep("A", "B")],
      { statusDate: D("8") },
    );
    expect(r.tasks.get("A")).toMatchObject({ start: D("2"), finish: D("5"), durationDays: 4, totalFloat: null, isCritical: false, state: "complete" });
    expect(span(r, "B")).toBe(`${D("8")}..${D("9")}`);
  });

  it("an overrunning task extends to the status date and warns", () => {
    const r = run([t("A", 5, { actualStart: D("2") }), t("B", 1)], [dep("A", "B")], { statusDate: D("10") });
    expect(r.tasks.get("A")).toMatchObject({ start: D("2"), finish: D("10"), state: "in_progress" });
    expect(span(r, "B")).toBe(`${D("11")}..${D("11")}`);
    expect(r.warnings).toContainEqual({ kind: "overrun", taskId: "A", plannedFinish: D("6") });
  });

  it("a complete successor doesn't take float from unfinished predecessors", () => {
    const r = run([t("A", 3), t("B", 2, { actualStart: D("2"), actualFinish: D("3") }), t("C", 10)], [dep("A", "B")]);
    expect(r.tasks.get("A")?.totalFloat).toBe(7);
  });
});

describe("deadlines", () => {
  it("a missed task deadline creates negative float back along the chain", () => {
    const r = run([t("A", 3), t("B", 2, { deadline: D("5") })], [dep("A", "B")]);
    expect(r.tasks.get("A")?.totalFloat).toBe(-1);
    expect(r.tasks.get("B")?.totalFloat).toBe(-1);
    expect(r.warnings).toContainEqual({ kind: "deadline_missed", taskId: "B", deadline: D("5"), finish: D("6"), daysLate: 1 });
  });

  it("a project deadline tightens everything", () => {
    const r = run([t("A", 3), t("B", 5)], [], { projectDeadline: D("4") });
    expect(r.tasks.get("A")?.totalFloat).toBe(0);
    expect(r.tasks.get("B")?.totalFloat).toBe(-2);
    expect(r.warnings).toContainEqual({ kind: "project_deadline_missed", deadline: D("4"), finish: D("6"), daysLate: 2 });
  });

  it("a later project deadline doesn't hide the critical path", () => {
    const r = run([t("A", 3)], [], { projectDeadline: D("30") });
    expect(r.criticalPath).toEqual(["A"]);
  });

  it("a group deadline applies to its children", () => {
    const r = run([t("P", 0), t("A", 3, { parentId: "P" }), t("G", 0, { deadline: D("3") }), t("B", 1, { parentId: "G" })]);
    expect(r.tasks.get("B")?.totalFloat).toBe(1);
  });
});

describe("summary tasks", () => {
  const tree = [
    t("P", 0),
    t("A", 2, { parentId: "P" }),
    t("B", 3, { parentId: "P" }),
    t("Q", 0),
    t("C", 1, { parentId: "Q" }),
  ];

  it("roll up from children and accept group-to-group links", () => {
    const r = run(tree, [dep("A", "B"), dep("P", "Q")]);
    expect(r.tasks.get("P")).toMatchObject({ start: D("2"), finish: D("6"), durationDays: 5, isSummary: true, isCritical: true });
    expect(span(r, "C")).toBe(`${D("7")}..${D("7")}`);
  });

  it("rejects links that read a group's start as a predecessor", () => {
    const r = schedule({ projectStart: START, tasks: tree, dependencies: [dep("P", "Q", "SS")] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatchObject({ kind: "invalid_dependency" });
  });

  it("rejects links between a task and its own group", () => {
    const r = schedule({ projectStart: START, tasks: tree, dependencies: [dep("P", "A")] });
    expect(r.ok).toBe(false);
  });

  it("derives group state from children", () => {
    const r = run([t("P", 0), t("A", 1, { parentId: "P", actualStart: D("2"), actualFinish: D("2") }), t("B", 1, { parentId: "P" })]);
    expect(r.tasks.get("P")?.state).toBe("in_progress");
  });
});

describe("validation", () => {
  it("reports a dependency cycle as a path", () => {
    const r = schedule({ projectStart: START, tasks: [t("A", 1), t("B", 1), t("C", 1)], dependencies: [dep("A", "B"), dep("B", "C"), dep("C", "A")] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e = r.errors[0];
      expect(e?.kind).toBe("dependency_cycle");
      if (e?.kind === "dependency_cycle") expect([...e.taskIds].sort()).toEqual(["A", "B", "C"]);
    }
  });

  it("reports parent cycles, unknown tasks and bad fields", () => {
    const pc = schedule({ projectStart: START, tasks: [t("A", 1, { parentId: "B" }), t("B", 1, { parentId: "A" })], dependencies: [] });
    expect(pc.ok || pc.errors[0]?.kind).toBe("parent_cycle");

    const unk = schedule({ projectStart: START, tasks: [t("A", 1)], dependencies: [dep("A", "Z")] });
    expect(unk.ok || unk.errors[0]).toEqual({ kind: "unknown_task", taskId: "Z" });

    const bad = schedule({ projectStart: START, tasks: [t("A", 1.5), t("B", 1, { constraintType: "SNET" })], dependencies: [] });
    expect(bad.ok || bad.errors.map((e) => e.kind)).toEqual(["invalid_task", "invalid_task"]);
  });
});

describe("slip impact", () => {
  it("diffs two schedules", () => {
    const tasks = [t("A", 3), t("B", 2), t("C", 4), t("D", 1)];
    const deps = [dep("A", "B"), dep("A", "C"), dep("B", "D"), dep("C", "D")];
    const before = run(tasks, deps);
    const after = run(tasks.map((x) => (x.id === "B" ? { ...x, durationDays: 5 } : x)), deps);
    const changes = new Map(diffSchedules(before.tasks, after.tasks).map((c) => [c.taskId, c]));
    expect(changes.get("B")).toMatchObject({ startDelta: 0, finishDelta: 3, becameCritical: true });
    expect(changes.get("C")).toMatchObject({ startDelta: 0, finishDelta: 0, floatDelta: 1, leftCritical: true });
    expect(changes.get("D")).toMatchObject({ startDelta: 1 });
  });
});

// ── Properties on random acyclic networks ───────────────────────────────────

const network = fc
  .integer({ min: 1, max: 25 })
  .chain((n) =>
    fc.record({
      durations: fc.array(fc.integer({ min: 0, max: 15 }), { minLength: n, maxLength: n }),
      edges: fc.uniqueArray(
        fc.record({
          a: fc.integer({ min: 0, max: n - 1 }),
          b: fc.integer({ min: 0, max: n - 1 }),
          type: fc.constantFrom("FS" as const, "SS" as const, "FF" as const, "SF" as const),
          lag: fc.integer({ min: -5, max: 5 }),
        }),
        { selector: (e) => `${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`, maxLength: n * 2 },
      ),
    }),
  )
  .map(({ durations, edges }) => ({
    tasks: durations.map((d, i) => t(`T${i}`, d)),
    deps: edges.filter((e) => e.a !== e.b).map((e) => dep(`T${Math.min(e.a, e.b)}`, `T${Math.max(e.a, e.b)}`, e.type, e.lag)),
  }));

const ex = (start: DayDate, finish: DayDate, d: number) => {
  const s = toEpochDay(start);
  return { s, f: d === 0 ? s : toEpochDay(finish) + 1 };
};

function satisfied(type: SchedDependency["type"], lag: number, p: { s: number; f: number }, q: { s: number; f: number }) {
  switch (type) {
    case "FS": return q.s >= p.f + lag;
    case "SS": return q.s >= p.s + lag;
    case "FF": return q.f >= p.f + lag;
    case "SF": return q.f >= p.s + lag;
  }
}

describe("properties", () => {
  it("early and late schedules both satisfy every link; float ≥ 0; a critical path exists", () => {
    fc.assert(
      fc.property(network, ({ tasks, deps }) => {
        const r = run(tasks, deps);
        const startIdx = toEpochDay(START);
        for (const task of tasks) {
          const s = r.tasks.get(task.id) as TaskSchedule;
          if (toEpochDay(s.start) < startIdx) return false;
          if ((s.totalFloat as number) < 0) return false;
          if ((s.freeFloat as number) > (s.totalFloat as number)) return false;
        }
        for (const e of deps) {
          const p = r.tasks.get(e.predecessorId) as TaskSchedule;
          const q = r.tasks.get(e.successorId) as TaskSchedule;
          if (!satisfied(e.type, e.lagDays, ex(p.start, p.finish, p.durationDays), ex(q.start, q.finish, q.durationDays))) return false;
          if (!satisfied(e.type, e.lagDays, ex(p.lateStart, p.lateFinish, p.durationDays), ex(q.lateStart, q.lateFinish, q.durationDays))) return false;
        }
        return r.criticalPath.length > 0;
      }),
      { numRuns: 500 },
    );
  });

  it("is independent of input order", () => {
    fc.assert(
      fc.property(network, fc.integer(), ({ tasks, deps }, seed) => {
        const shuffled = [...tasks].sort((a, b) => ((a.id.length * 31 + seed) ^ a.id.charCodeAt(1)) - ((b.id.length * 31 + seed) ^ b.id.charCodeAt(1)));
        const a = run(tasks, deps);
        const b = run(shuffled, [...deps].reverse());
        return tasks.every((x) => JSON.stringify(a.tasks.get(x.id)) === JSON.stringify(b.tasks.get(x.id)));
      }),
      { numRuns: 200 },
    );
  });
});
