/**
 * Sample programme: a kitchen knock-through and rear extension on a 1964 house.
 * Durations are calendar days (the v1 model), so curing and lead times read naturally.
 * Clearly example data; the prototype offers "Reset sample" to return here.
 */
import type { ConstraintType, DependencyType } from "@23andus/domain";
import type { PDep, PState, PTask } from "./model.ts";

export const AREAS = ["Kitchen", "Rear extension", "Hall & stairs", "Utility", "Whole house", "Outside"];

type Row = [key: string, title: string, days: number, area: string, extra?: Partial<PTask>];
type Link = [pred: string, succ: string, type?: DependencyType, lag?: number];

const rows: Row[] = [
  ["1", "Preparation", 0, "Whole house"],
  ["1.1", "Building Control notice submitted", 0, "Whole house", { constraintType: "MSO" as ConstraintType, constraintDate: "2026-11-02" }],
  ["1.2", "Skip, welfare and dust protection", 1, "Outside"],
  ["1.3", "Strip out old kitchen", 3, "Kitchen"],
  ["1.4", "Asbestos survey of 1964 artex ceiling", 2, "Kitchen"],
  ["2", "Structure", 0, "Rear extension"],
  ["2.1", "Knock through and install steel", 4, "Rear extension"],
  ["2.2", "Building Control: steel inspection", 0, "Rear extension"],
  ["2.3", "Make good brickwork and lintels", 2, "Rear extension"],
  ["3", "First fix", 0, "Kitchen"],
  ["3.1", "Electrics first fix", 3, "Kitchen"],
  ["3.2", "Plumbing first fix", 2, "Kitchen"],
  ["3.3", "Gas first fix (Gas Safe engineer)", 1, "Kitchen"],
  ["4", "Walls and floor", 0, "Kitchen"],
  ["4.1", "Plasterboard and skim", 4, "Kitchen"],
  ["4.2", "Plaster drying", 7, "Kitchen"],
  ["4.3", "Lay screed", 1, "Rear extension"],
  ["4.4", "Screed curing", 21, "Rear extension"],
  ["4.5", "Lay floor tiles", 3, "Kitchen"],
  ["5", "Kitchen install", 0, "Kitchen"],
  ["5.1", "Units delivered", 0, "Kitchen", { constraintType: "MSO" as ConstraintType, constraintDate: "2026-12-01" }],
  ["5.2", "Fit units and template worktops", 3, "Kitchen"],
  ["5.3", "Worktop fabrication", 10, "Kitchen"],
  ["5.4", "Fit worktops", 1, "Kitchen"],
  ["5.5", "Second fix: electrics and plumbing", 2, "Kitchen"],
  ["5.6", "Tile splashback", 2, "Kitchen"],
  ["6", "Sign-off", 0, "Whole house"],
  ["6.1", "Decorate", 4, "Kitchen"],
  ["6.2", "Electrical installation certificate", 0, "Whole house"],
  ["6.3", "Building Control completion certificate", 0, "Whole house"],
];

const links: Link[] = [
  ["1.2", "1.3"], ["1.1", "1.4"], ["1.3", "1.4", "SS"],
  ["1.3", "2.1"], ["1.4", "2.1"], ["2.1", "2.2"], ["2.2", "2.3"],
  ["2.3", "3.1"], ["3.1", "3.2", "SS", 1], ["3.2", "3.3"],
  ["3.1", "4.1"], ["3.3", "4.1"], ["4.1", "4.2"], ["2.3", "4.3"], ["4.3", "4.4"],
  ["4.4", "4.5"], ["4.2", "5.2"], ["5.1", "5.2"], ["4.5", "5.2"],
  ["5.2", "5.3"], ["5.3", "5.4"], ["5.4", "5.5"], ["5.4", "5.6"],
  ["4.2", "6.1"], ["5.6", "6.1"], ["5.5", "6.2"], ["6.1", "6.3"], ["6.2", "6.3"],
];

let n = 0;
const id = () => `t${(++n).toString(36)}`;

export function sampleState(): PState {
  n = 0;
  const byKey = new Map<string, PTask>();
  const tasks: PTask[] = rows.map(([key, title, days, area, extra], i) => {
    const parentKey = key.includes(".") ? key.slice(0, key.lastIndexOf(".")) : null;
    const t: PTask = {
      id: id(),
      parentId: parentKey ? (byKey.get(parentKey)?.id ?? null) : null,
      sort: (i + 1) * 1024,
      title,
      area,
      duration: days,
      status: "todo",
      constraintType: "ASAP",
      constraintDate: null,
      deadline: null,
      actualStart: null,
      actualFinish: null,
      ...extra,
    };
    byKey.set(key, t);
    return t;
  });
  const deps: PDep[] = links.map(([p, s, type = "FS", lag = 0]) => ({
    id: id(),
    pred: byKey.get(p)?.id as string,
    succ: byKey.get(s)?.id as string,
    type,
    lag,
  }));
  return {
    tasks,
    deps,
    projectStart: "2026-11-02",
    projectDeadline: "2026-12-31",
    statusDate: null,
  };
}
