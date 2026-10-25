import { diffDays } from "@reno/domain";
import type { TaskSchedule } from "./types.ts";

export interface ScheduleChange {
  taskId: string;
  startDelta: number;
  finishDelta: number;
  floatDelta: number | null;
  becameCritical: boolean;
  leftCritical: boolean;
}

/**
 * What moved between two schedules — the basis for "slip impact" previews:
 * run `schedule()` on the current plan and on the edited plan, then diff.
 * Deltas are calendar days (positive = later).
 */
export function diffSchedules(
  before: ReadonlyMap<string, TaskSchedule>,
  after: ReadonlyMap<string, TaskSchedule>,
): ScheduleChange[] {
  const out: ScheduleChange[] = [];
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a) continue;
    const startDelta = diffDays(b.start, a.start);
    const finishDelta = diffDays(b.finish, a.finish);
    const floatDelta = a.totalFloat !== null && b.totalFloat !== null ? a.totalFloat - b.totalFloat : null;
    const becameCritical = a.isCritical && !b.isCritical;
    const leftCritical = b.isCritical && !a.isCritical;
    if (startDelta || finishDelta || floatDelta || becameCritical || leftCritical) {
      out.push({ taskId: id, startDelta, finishDelta, floatDelta, becameCritical, leftCritical });
    }
  }
  return out;
}
