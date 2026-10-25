import type { ConstraintType, DependencyType } from "@23andus/domain";

export type Status = "todo" | "in_progress" | "blocked" | "done" | "cancelled";
export const BOARD_STATUSES = ["todo", "in_progress", "blocked", "done"] as const satisfies readonly Status[];
export const STATUS_LABEL: Record<Status, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

export interface Task {
  id: string;
  parentId: string | null;
  sort: number;
  title: string;
  description: string;
  areaId: string | null;
  duration: number;
  status: Status;
  constraintType: ConstraintType;
  constraintDate: string | null;
  deadline: string | null;
  actualStart: string | null;
  actualFinish: string | null;
}

export interface Dep {
  id: string;
  pred: string;
  succ: string;
  type: DependencyType;
  lag: number;
}

export interface CostLine {
  id: string;
  taskId: string | null;
  categoryId: string;
  description: string;
  estimate: number | null; // pence, gross
  actual: number | null; // pence, gross
  supplier: string;
}

export interface Project {
  id: string;
  householdId: string;
  name: string;
  startDate: string;
  deadline: string | null;
  budget: number | null; // pence
  contingencyPct: number;
}

/** Everything a commit can change. Saved to Supabase by diffing before/after. */
export interface WState {
  project: Project;
  tasks: Task[];
  deps: Dep[];
  costs: CostLine[];
}

export interface Lookup {
  id: string;
  name: string;
}
