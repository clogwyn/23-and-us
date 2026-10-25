import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  addDays,
  dayDate,
  diffDays,
  fromEpochDay,
  isDayDate,
  toEpochDay,
  todayIn,
} from "./daydate.ts";
import { formatGBP, parseGBP, pence, percentOf, sumPence } from "./money.ts";
import { formatPredecessorCode, parsePredecessorCode } from "./predecessor-code.ts";
import { flattenTree, sortBetween } from "./tree.ts";
import { taskInput } from "./schemas.ts";

describe("DayDate", () => {
  it("validates real calendar days only", () => {
    expect(isDayDate("2026-02-28")).toBe(true);
    expect(isDayDate("2026-02-29")).toBe(false);
    expect(isDayDate("2028-02-29")).toBe(true);
    expect(isDayDate("2026-13-01")).toBe(false);
    expect(isDayDate("26-01-01")).toBe(false);
  });

  it("crosses the BST change without drift (last Sunday of October)", () => {
    expect(addDays(dayDate("2026-10-24"), 2)).toBe("2026-10-26");
    expect(diffDays(dayDate("2026-03-28"), dayDate("2026-03-30"))).toBe(2);
  });

  it("round-trips epoch days", () => {
    fc.assert(
      fc.property(fc.integer({ min: -50_000, max: 100_000 }), (n) => toEpochDay(fromEpochDay(n)) === n),
    );
  });

  it("computes today in London, not UTC", () => {
    // 23:30 UTC on 30 June is already 1 July in London (BST, UTC+1)
    expect(todayIn("Europe/London", new Date("2026-06-30T23:30:00Z"))).toBe("2026-07-01");
  });
});

describe("Pence", () => {
  it.each([
    ["£1,234.56", 123456],
    ["1234", 123400],
    ["£0.5", 50],
    [".99", 99],
    ["-£20.05", -2005],
    [" £ 12 ", 1200],
  ])("parses %s", (input, expected) => {
    expect(parseGBP(input)).toBe(expected);
  });

  it.each(["", "£", "12.345", "1,23", "abc", "£1,2345"])("rejects %s", (input) => {
    expect(parseGBP(input)).toBeNull();
  });

  it("formats en-GB", () => {
    expect(formatGBP(pence(123456))).toBe("£1,234.56");
    expect(formatGBP(pence(123456), { whole: true })).toBe("£1,235");
  });

  it("parse ∘ format is identity", () => {
    fc.assert(fc.property(fc.integer({ min: -1e9, max: 1e9 }), (n) => parseGBP(formatGBP(pence(n))) === n));
  });

  it("sums and percents exactly", () => {
    expect(sumPence([pence(10), null, pence(5), undefined])).toBe(15);
    expect(percentOf(pence(1005), 10)).toBe(101); // 100.5 → 101
    expect(percentOf(pence(-1005), 10)).toBe(-101);
  });
});

describe("predecessor codes", () => {
  it("parses the documented forms", () => {
    const r = parsePredecessorCode("4, 1.2SS-1d; 3ff+1w, 7+2");
    expect(r).toEqual({
      ok: true,
      value: [
        { ref: "4", type: "FS", lagDays: 0 },
        { ref: "1.2", type: "SS", lagDays: -1 },
        { ref: "3", type: "FF", lagDays: 7 },
        { ref: "7", type: "FS", lagDays: 2 },
      ],
    });
  });

  it("treats blank as no predecessors", () => {
    expect(parsePredecessorCode("   ")).toEqual({ ok: true, value: [] });
  });

  it.each(["4XX", "FS", "4FS+", "1..2", "4, 4SS"])("rejects %s", (s) => {
    expect(parsePredecessorCode(s).ok).toBe(false);
  });

  it("format → parse round-trips", () => {
    const ref = fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 3 }).map((a) => a.join("."));
    const item = fc.record({
      ref,
      type: fc.constantFrom("FS" as const, "SS" as const, "FF" as const, "SF" as const),
      lagDays: fc.integer({ min: -30, max: 30 }),
    });
    fc.assert(
      fc.property(fc.uniqueArray(item, { selector: (i) => i.ref, maxLength: 5 }), (items) => {
        const r = parsePredecessorCode(formatPredecessorCode(items));
        return r.ok && JSON.stringify(r.value) === JSON.stringify(items);
      }),
    );
  });
});

describe("tree", () => {
  const nodes = [
    { id: "c", parentId: "a", sort: 2 },
    { id: "a", parentId: null, sort: 1 },
    { id: "b", parentId: "a", sort: 1 },
    { id: "d", parentId: null, sort: 2 },
    { id: "e", parentId: "b", sort: 1 },
  ];

  it("flattens depth-first with WBS codes", () => {
    expect(flattenTree(nodes).map((r) => `${r.wbs}:${r.node.id}:${r.depth}`)).toEqual([
      "1:a:0",
      "1.1:b:1",
      "1.1.1:e:2",
      "1.2:c:1",
      "2:d:0",
    ]);
  });

  it("detects parent cycles", () => {
    expect(() =>
      flattenTree([
        { id: "x", parentId: "y", sort: 1 },
        { id: "y", parentId: "x", sort: 1 },
      ]),
    ).toThrow(/cycle/);
  });

  it("finds sort keys between neighbours", () => {
    expect(sortBetween(1024, 2048)).toBe(1536);
    expect(sortBetween(null, 1024)).toBe(0);
    expect(sortBetween(2048, null)).toBe(3072);
  });
});

describe("taskInput", () => {
  const base = { projectId: "6f1c0b0e-2b7e-4c1a-9a8e-0a4b1c2d3e4f", title: "Rewire kitchen" };

  it("applies defaults", () => {
    const t = taskInput.parse(base);
    expect(t).toMatchObject({ status: "todo", durationDays: 1, constraintType: "ASAP" });
  });

  it("requires a date for non-ASAP constraints", () => {
    expect(taskInput.safeParse({ ...base, constraintType: "MSO" }).success).toBe(false);
  });

  it("rejects finish before start", () => {
    expect(
      taskInput.safeParse({ ...base, actualStart: "2026-11-05", actualFinish: "2026-11-01" }).success,
    ).toBe(false);
  });
});
