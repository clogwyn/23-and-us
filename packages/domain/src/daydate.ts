import type { Brand } from "./brand.ts";

/**
 * A calendar day with no time or zone: ISO `YYYY-MM-DD`.
 * All schedule arithmetic happens on whole days, so we never touch `Date` local time.
 */
export type DayDate = Brand<string, "DayDate">;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export function isDayDate(s: string): s is DayDate {
  const m = ISO_DAY.exec(s);
  if (!m) return false;
  const [, y, mo, d] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  return new Date(t).toISOString().slice(0, 10) === s;
}

export function dayDate(s: string): DayDate {
  if (!isDayDate(s)) throw new RangeError(`Invalid DayDate: "${s}"`);
  return s;
}

/** Days since 1970-01-01. Monotonic integer — the engine's native unit. */
export function toEpochDay(d: DayDate): number {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, day) / MS_PER_DAY);
}

export function fromEpochDay(n: number): DayDate {
  if (!Number.isInteger(n)) throw new RangeError(`Epoch day must be an integer, got ${n}`);
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10) as DayDate;
}

export function addDays(d: DayDate, n: number): DayDate {
  return fromEpochDay(toEpochDay(d) + n);
}

/** b − a in days. */
export function diffDays(a: DayDate, b: DayDate): number {
  return toEpochDay(b) - toEpochDay(a);
}

export function compareDayDate(a: DayDate, b: DayDate): number {
  return a < b ? -1 : a > b ? 1 : 0; // ISO strings sort lexically
}

/** Today in a given IANA zone (default Europe/London), not the server's zone. */
export function todayIn(timeZone = "Europe/London", now: Date = new Date()): DayDate {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return dayDate(parts);
}

const fmtShort = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" });

/** e.g. "03 Nov 26" — fixed width for dense tables. */
export function formatDayDate(d: DayDate): string {
  return fmtShort.format(new Date(toEpochDay(d) * MS_PER_DAY));
}
