import type { Brand } from "./brand.ts";

/** Integer pence, gross (VAT inclusive). Never a float. */
export type Pence = Brand<number, "Pence">;

export function pence(n: number): Pence {
  if (!Number.isSafeInteger(n)) throw new RangeError(`Pence must be a safe integer, got ${n}`);
  return n as Pence;
}

export const ZERO: Pence = 0 as Pence;

export function sumPence(values: Iterable<Pence | null | undefined>): Pence {
  let t = 0;
  for (const v of values) if (v != null) t += v;
  return pence(t);
}

/** actual − estimate. Positive = over budget. */
export function variance(estimate: Pence, actual: Pence): Pence {
  return pence(actual - estimate);
}

/** Round-half-away-from-zero percentage of an amount, e.g. contingency. */
export function percentOf(amount: Pence, pct: number): Pence {
  const raw = (amount * pct) / 100;
  return pence(Math.sign(raw) * Math.round(Math.abs(raw)));
}

const GBP_INPUT = /^\s*(-)?\s*£?\s*(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{1,2}))?\s*$/;

/**
 * Parse user input like "£1,234.5", "1234", "-£20.05", ".99" without floating point.
 * Returns null for anything ambiguous.
 */
export function parseGBP(input: string): Pence | null {
  const m = GBP_INPUT.exec(input);
  if (!m) return null;
  const [, neg, whole, frac] = m;
  if (whole === undefined && frac === undefined) return null;
  const pounds = Number((whole ?? "0").replaceAll(",", ""));
  const p = Number((frac ?? "").padEnd(2, "0") || "0");
  const total = pounds * 100 + p;
  if (!Number.isSafeInteger(total)) return null;
  return pence(neg ? -total : total);
}

const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const gbpWhole = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });

export function formatGBP(p: Pence, opts: { whole?: boolean } = {}): string {
  return (opts.whole ? gbpWhole : gbp).format(p / 100);
}
