/**
 * MS Project–style predecessor codes, as typed in the task table:
 *
 *   "4"            → task 4, finish-to-start, no lag
 *   "4FS+2d"       → task 4, FS, 2 days lag
 *   "1.2SS-1d"     → WBS 1.2, start-to-start, 1 day lead
 *   "3, 5FF+1w"    → two links; 1w = 7 days
 *   "4+2"          → FS implied, unit defaults to days
 *
 * References are WBS codes (display positions). The caller resolves them to task ids;
 * storage is always by id, so reordering never breaks links.
 */
import { DEPENDENCY_TYPES, type DependencyType } from "./enums.ts";

export interface PredecessorRef {
  ref: string;
  type: DependencyType;
  lagDays: number;
}

export type ParseResult =
  | { ok: true; value: PredecessorRef[] }
  | { ok: false; error: string; at: number };

const ITEM = /^\s*(\d+(?:\.\d+)*)\s*(FS|SS|FF|SF)?\s*(?:([+-])\s*(\d+)\s*(d|w)?)?\s*$/i;

export function parsePredecessorCode(input: string): ParseResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: true, value: [] };

  const out: PredecessorRef[] = [];
  const seen = new Set<string>();
  let offset = 0;

  for (const raw of input.split(/[,;]/)) {
    const m = ITEM.exec(raw);
    if (!m) {
      return { ok: false, error: `Can't read "${raw.trim()}". Expected e.g. 4, 4FS+2d, 1.2SS-1d`, at: offset };
    }
    const [, ref, type, sign, num, unit] = m as unknown as [string, string, string?, string?, string?, string?];
    const t = (type?.toUpperCase() ?? "FS") as DependencyType;
    const mult = unit?.toLowerCase() === "w" ? 7 : 1;
    const lag = num === undefined ? 0 : (sign === "-" ? -1 : 1) * Number(num) * mult;

    if (seen.has(ref)) return { ok: false, error: `Task ${ref} is listed twice`, at: offset };
    seen.add(ref);
    out.push({ ref, type: t, lagDays: lag });
    offset += raw.length + 1;
  }
  return { ok: true, value: out };
}

export function formatPredecessorCode(refs: readonly PredecessorRef[]): string {
  return refs
    .map(({ ref, type, lagDays }) => {
      if (type === "FS" && lagDays === 0) return ref;
      const lag = lagDays === 0 ? "" : `${lagDays > 0 ? "+" : "-"}${Math.abs(lagDays)}d`;
      return `${ref}${type}${lag}`;
    })
    .join(", ");
}

/** Type guard for values coming from the database or forms. */
export function isDependencyType(s: string): s is DependencyType {
  return (DEPENDENCY_TYPES as readonly string[]).includes(s);
}
