import type { ConstraintType, DependencyType } from "@23andus/domain";

export type PStatus = "todo" | "in_progress" | "blocked" | "done";

export interface PTask {
  id: string;
  parentId: string | null;
  sort: number;
  title: string;
  area: string;
  duration: number;
  status: PStatus;
  constraintType: ConstraintType;
  constraintDate: string | null;
  deadline: string | null;
  actualStart: string | null;
  actualFinish: string | null;
}

export interface PDep {
  id: string;
  pred: string;
  succ: string;
  type: DependencyType;
  lag: number;
}

/** Everything that is saved and undoable. View state (selection, filters) lives elsewhere. */
export interface PState {
  tasks: PTask[];
  deps: PDep[];
  projectStart: string;
  projectDeadline: string | null;
  statusDate: string | null;
}
