import type { FlatRow } from "@23andus/domain";
import type { ScheduleResult, TaskSchedule } from "@23andus/scheduler";
import type { PState, PStatus, PTask } from "./model.ts";

/** What each view needs from the app shell. Views never touch state directly; they go through commit(). */
export interface ViewCtx {
  state(): PState;
  result(): ScheduleResult;
  byId(id: string): PTask | undefined;
  isSummary(id: string): boolean;
  sched(id: string): TaskSchedule | undefined;
  rows(): FlatRow<{ id: string; parentId: string | null; sort: number }>[];
  selected(): string | null;
  select(id: string | null): void;
  /** Returns true if the change was accepted. A string from the mutator refuses it with that message. */
  commit(mutate: (s: PState) => unknown): boolean;
  setStatus(task: PTask, status: PStatus): undefined;
  toast(msg: string): void;
  wbs(id: string): string;
  fmt(d: string): string;
  fmtLong(d: string): string;
  esc(s: string): string;
  statusLabel: Record<PStatus, string>;
}
