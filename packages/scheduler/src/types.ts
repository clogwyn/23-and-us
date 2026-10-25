import type { ConstraintType, DayDate, DependencyType } from "@reno/domain";
import type { Calendar } from "./calendar.ts";

export interface SchedTask {
  id: string;
  parentId: string | null;
  /** Planned duration in working periods. Ignored for summary tasks (derived from children). 0 = milestone. */
  durationDays: number;
  constraintType?: ConstraintType;
  constraintDate?: DayDate | null;
  /** Soft target. Missing it yields negative float and a warning, never moves the task. Applies to all descendants. */
  deadline?: DayDate | null;
  actualStart?: DayDate | null;
  /** Setting this marks the task complete; its dates become fixed history. */
  actualFinish?: DayDate | null;
}

export interface SchedDependency {
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
}

export interface ScheduleInput {
  projectStart: DayDate;
  projectDeadline?: DayDate | null;
  /** "As of" date. Unstarted work can't be scheduled before it; in-progress work can't finish before it. */
  statusDate?: DayDate | null;
  calendar?: Calendar;
  tasks: readonly SchedTask[];
  dependencies: readonly SchedDependency[];
}

export type TaskState = "not_started" | "in_progress" | "complete";

export interface TaskSchedule {
  /** First working day. */
  start: DayDate;
  /** Last working day (inclusive). Equals start for milestones. */
  finish: DayDate;
  lateStart: DayDate;
  lateFinish: DayDate;
  /** Working periods. Summaries: span of children. Complete tasks: actual duration. */
  durationDays: number;
  /** How far this can slip before the project end (or a deadline) moves. null when complete. */
  totalFloat: number | null;
  /** How far this can slip before any successor moves. null when complete. */
  freeFloat: number | null;
  isCritical: boolean;
  isSummary: boolean;
  isMilestone: boolean;
  state: TaskState;
}

export type ScheduleWarning =
  | { kind: "deadline_missed"; taskId: string; deadline: DayDate; finish: DayDate; daysLate: number }
  | { kind: "project_deadline_missed"; deadline: DayDate; finish: DayDate; daysLate: number }
  | { kind: "constraint_conflict"; taskId: string; constraintType: ConstraintType; constraintDate: DayDate; drivenStart: DayDate }
  | { kind: "overrun"; taskId: string; plannedFinish: DayDate }
  | { kind: "summary_field_ignored"; taskId: string; field: "constraint" | "actuals" | "duration" };

export type ScheduleError =
  | { kind: "duplicate_task"; taskId: string }
  | { kind: "missing_parent"; taskId: string; parentId: string }
  | { kind: "parent_cycle"; taskIds: string[] }
  | { kind: "invalid_task"; taskId: string; reason: string }
  | { kind: "unknown_task"; taskId: string }
  | { kind: "invalid_dependency"; predecessorId: string; successorId: string; reason: string }
  | { kind: "dependency_cycle"; taskIds: string[] };

export type ScheduleResult =
  | {
      ok: true;
      tasks: Map<string, TaskSchedule>;
      projectStart: DayDate;
      projectFinish: DayDate;
      /** Critical leaf tasks in topological order. */
      criticalPath: string[];
      warnings: ScheduleWarning[];
    }
  | { ok: false; errors: ScheduleError[] };
