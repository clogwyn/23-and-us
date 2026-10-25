import { formatGBP, pence } from "@23andus/domain";
import type { ScheduleError, ScheduleWarning } from "@23andus/scheduler";
import type { Dep, WState } from "./types";

const dateFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
const longFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" });
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

/** "Mon 02 Nov" — fixed width for tables. */
export const fmt = (d: string) => dateFmt.format(asDate(d)).replace(",", "");
/** "Mon 2 November" — for sentences. */
export const fmtLong = (d: string) => longFmt.format(asDate(d)).replace(",", "");
export const isWeekend = (d: string) => [0, 6].includes(asDate(d).getUTCDay());
export const days = (n: number) => `${Math.abs(n)} day${Math.abs(n) === 1 ? "" : "s"}`;
export const money = (p: number | null | undefined, whole = true) => (p === null || p === undefined ? "—" : formatGBP(pence(p), { whole }));
export const linkLabel = (d: Pick<Dep, "type" | "lag">) => `${d.type}${d.lag ? `${d.lag > 0 ? "+" : "−"}${Math.abs(d.lag)}d` : ""}`;

const ref = (id: string, s: WState, wbs: Map<string, string>) => `${wbs.get(id) ?? "?"} ${s.tasks.find((t) => t.id === id)?.title ?? "a task"}`;

export function describeErrors(errors: ScheduleError[], s: WState, wbs: Map<string, string>): string {
  const e = errors[0];
  if (!e) return "That change isn't valid.";
  switch (e.kind) {
    case "dependency_cycle":
      return `That would create a loop: ${[...e.taskIds, e.taskIds[0] as string].map((id) => wbs.get(id) ?? "?").join(" → ")}. Remove one of those links first.`;
    case "invalid_dependency":
      return `${e.reason} (${wbs.get(e.predecessorId) ?? "?"} → ${wbs.get(e.successorId) ?? "?"}).`;
    case "parent_cycle":
      return "A task can't sit inside its own subtask.";
    case "invalid_task":
      return `${ref(e.taskId, s, wbs)}: ${e.reason}.`;
    case "unknown_task":
      return "That link points to a task that no longer exists.";
    case "missing_parent":
      return "That task's group no longer exists.";
    case "duplicate_task":
      return "Two tasks share an id.";
  }
}

export function describeWarning(w: ScheduleWarning, s: WState, wbs: Map<string, string>): string {
  switch (w.kind) {
    case "project_deadline_missed":
      return `The project finishes ${fmtLong(w.finish)}, ${days(w.daysLate)} after the deadline.`;
    case "deadline_missed":
      return `${ref(w.taskId, s, wbs)} finishes ${fmtLong(w.finish)}, ${days(w.daysLate)} after it's due.`;
    case "constraint_conflict":
      return `${ref(w.taskId, s, wbs)} is fixed to ${w.constraintType === "MSO" ? "start" : "finish"} on ${fmtLong(w.constraintDate)}, but what comes before it would start it ${fmtLong(w.drivenStart)}.`;
    case "overrun":
      return `${ref(w.taskId, s, wbs)} was due to finish ${fmtLong(w.plannedFinish)} and is still in progress.`;
    case "summary_field_ignored":
      return `${ref(w.taskId, s, wbs)} is a group, so its own ${w.field} is ignored.`;
  }
}

