export const DEPENDENCY_TYPES = ["FS", "SS", "FF", "SF"] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const CONSTRAINT_TYPES = [
  "ASAP", // as soon as possible (default)
  "SNET", // start no earlier than
  "FNET", // finish no earlier than
  "MSO", //  must start on
  "MFO", //  must finish on
] as const;
export type ConstraintType = (typeof CONSTRAINT_TYPES)[number];

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const PROJECT_STATUSES = ["planning", "active", "on_hold", "complete", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const ATTACHMENT_KINDS = ["photo", "quote", "invoice", "drawing", "warranty", "other"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];
