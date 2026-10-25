import { fromEpochDay, toEpochDay, type DayDate } from "@reno/domain";

/**
 * Maps calendar dates onto a monotonic integer "working time" axis.
 * The engine does all arithmetic on these indices and converts only at the edges,
 * so swapping in a working-day calendar never touches the CPM code.
 *
 * Contract for implementations:
 *  - toIndex is non-decreasing; a non-working day maps to the index of the next working day.
 *  - fromIndex(toIndex(d)) >= d, and toIndex(fromIndex(i)) === i.
 *  - Durations and lags are counted in index units (working periods).
 */
export interface Calendar {
  readonly id: string;
  toIndex(d: DayDate): number;
  fromIndex(i: number): DayDate;
}

/** v1 calendar: every day is a working day, so one index unit = one calendar day. */
export const allDaysCalendar: Calendar = {
  id: "all-days",
  toIndex: toEpochDay,
  fromIndex: fromEpochDay,
};
