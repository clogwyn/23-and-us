/**
 * Input validation at the trust boundary (forms, server actions).
 * DB rows are typed by generated types in @23andus/db; these schemas validate what users send.
 */
import { z } from "zod";
import { isDayDate, type DayDate } from "./daydate.ts";
import {
  CONSTRAINT_TYPES,
  DEPENDENCY_TYPES,
  PROJECT_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  ATTACHMENT_KINDS,
} from "./enums.ts";
import type { Pence } from "./money.ts";

export const zDayDate = z
  .string()
  .refine(isDayDate, { message: "Expected a date as YYYY-MM-DD" })
  .transform((s) => s as DayDate);

export const zPence = z
  .number()
  .int({ message: "Amount must be whole pence" })
  .refine(Number.isSafeInteger)
  .transform((n) => n as Pence);

const zUuid = z.uuid();
const title = z.string().trim().min(1, "Required").max(200);
const longText = z.string().max(20_000);

export const projectInput = z
  .object({
    name: title,
    status: z.enum(PROJECT_STATUSES).default("planning"),
    startDate: zDayDate,
    deadline: zDayDate.nullable().default(null),
    contingencyPct: z.number().min(0).max(100).default(10),
    notes: longText.default(""),
  })
  .refine((p) => p.deadline === null || p.deadline >= p.startDate, {
    message: "Deadline must be on or after the start date",
    path: ["deadline"],
  });
export type ProjectInput = z.infer<typeof projectInput>;

export const taskInput = z
  .object({
    projectId: zUuid,
    parentId: zUuid.nullable().default(null),
    title,
    description: longText.default(""),
    status: z.enum(TASK_STATUSES).default("todo"),
    priority: z.enum(TASK_PRIORITIES).default("normal"),
    areaId: zUuid.nullable().default(null),
    assigneeId: zUuid.nullable().default(null),
    durationDays: z.number().int().min(0).max(3650).default(1),
    constraintType: z.enum(CONSTRAINT_TYPES).default("ASAP"),
    constraintDate: zDayDate.nullable().default(null),
    deadline: zDayDate.nullable().default(null),
    actualStart: zDayDate.nullable().default(null),
    actualFinish: zDayDate.nullable().default(null),
    percentComplete: z.number().int().min(0).max(100).default(0),
  })
  .superRefine((t, ctx) => {
    if (t.constraintType !== "ASAP" && t.constraintDate === null)
      ctx.addIssue({ code: "custom", message: "This constraint needs a date", path: ["constraintDate"] });
    if (t.constraintType === "ASAP" && t.constraintDate !== null)
      ctx.addIssue({ code: "custom", message: "ASAP tasks take no constraint date", path: ["constraintDate"] });
    if (t.actualFinish !== null && t.actualStart !== null && t.actualFinish < t.actualStart)
      ctx.addIssue({ code: "custom", message: "Finish can't be before start", path: ["actualFinish"] });
    if (t.actualFinish !== null && t.actualStart === null)
      ctx.addIssue({ code: "custom", message: "Set an actual start before an actual finish", path: ["actualStart"] });
  });
export type TaskInput = z.infer<typeof taskInput>;

export const dependencyInput = z
  .object({
    predecessorId: zUuid,
    successorId: zUuid,
    type: z.enum(DEPENDENCY_TYPES).default("FS"),
    lagDays: z.number().int().min(-365).max(365).default(0),
  })
  .refine((d) => d.predecessorId !== d.successorId, { message: "A task can't depend on itself" });
export type DependencyInput = z.infer<typeof dependencyInput>;

export const costLineInput = z.object({
  projectId: zUuid,
  taskId: zUuid.nullable().default(null),
  areaId: zUuid.nullable().default(null),
  categoryId: zUuid,
  description: title,
  estimatePence: zPence.nullable().default(null),
  actualPence: zPence.nullable().default(null),
  supplierText: z.string().trim().max(200).default(""),
  incurredOn: zDayDate.nullable().default(null),
});
export type CostLineInput = z.infer<typeof costLineInput>;

export const areaInput = z.object({
  name: title,
  parentId: zUuid.nullable().default(null),
});
export type AreaInput = z.infer<typeof areaInput>;

export const attachmentMeta = z.object({
  kind: z.enum(ATTACHMENT_KINDS),
  caption: z.string().trim().max(500).default(""),
  takenAt: zDayDate.nullable().default(null),
  mime: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/),
  bytes: z.number().int().positive().max(50 * 1024 * 1024), // Supabase per-file limit
});
export type AttachmentMeta = z.infer<typeof attachmentMeta>;
