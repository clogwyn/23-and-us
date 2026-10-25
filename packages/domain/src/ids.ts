import type { Brand } from "./brand.ts";

export type HouseholdId = Brand<string, "HouseholdId">;
export type ProjectId = Brand<string, "ProjectId">;
export type TaskId = Brand<string, "TaskId">;
export type AreaId = Brand<string, "AreaId">;
export type CostLineId = Brand<string, "CostLineId">;
export type CostCategoryId = Brand<string, "CostCategoryId">;
export type AttachmentId = Brand<string, "AttachmentId">;
export type UserId = Brand<string, "UserId">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID.test(s);
}
