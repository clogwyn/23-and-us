/**
 * 23 & Us — task table prototype.
 * Every change runs through the real @23andus/scheduler; invalid changes are refused
 * with the engine's reason, so what you see is exactly what the app will compute.
 */
import {
  CONSTRAINT_TYPES,
  diffDays,
  flattenTree,
  formatPredecessorCode,
  isDayDate,
  parsePredecessorCode,
  sortBetween,
  wbsMaps,
  type ConstraintType,
  type DayDate,
} from "@23andus/domain";
import {
  diffSchedules,
  schedule,
  type ScheduleError,
  type ScheduleInput,
  type ScheduleWarning,
  type TaskSchedule,
} from "@23andus/scheduler";
import type { PDep, PState, PStatus, PTask } from "./model.ts";
import { AREAS, sampleState } from "./sample.ts";

type Col = "title" | "area" | "duration" | "preds" | "status";

const STORE_KEY = "23andus-prototype-v1";
const COLS: Col[] = ["title", "area", "duration", "preds", "status"];
const STATUS_LABEL: Record<PStatus, string> = { todo: "To do", in_progress: "In progress", done: "Done" };
const CONSTRAINT_LABEL: Record<ConstraintType, string> = {
  ASAP: "As soon as possible",
  SNET: "Start no earlier than",
  FNET: "Finish no earlier than",
  MSO: "Must start on",
  MFO: "Must finish on",
};

// ── State ────────────────────────────────────────────────────────────────────
let state: PState = load() ?? sampleState();
const history: string[] = [];
const view = {
  selected: null as string | null,
  editing: null as { id: string; col: Col } | null,
  collapsed: new Set<string>(),
  criticalOnly: false,
  area: "",
  slip: null as { id: string; delta: number } | null,
};

function load(): PState | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as PState) : null;
  } catch {
    return null;
  }
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* private mode: prototype still works, just doesn't persist */
  }
}

// ── Engine bridge ────────────────────────────────────────────────────────────
function toInput(s: PState, override?: { id: string; duration: number }): ScheduleInput {
  return {
    projectStart: s.projectStart as DayDate,
    projectDeadline: (s.projectDeadline as DayDate | null) ?? null,
    statusDate: (s.statusDate as DayDate | null) ?? null,
    tasks: s.tasks.map((t) => ({
      id: t.id,
      parentId: t.parentId,
      durationDays: override?.id === t.id ? override.duration : t.duration,
      constraintType: t.constraintType,
      constraintDate: t.constraintDate as DayDate | null,
      deadline: t.deadline as DayDate | null,
      actualStart: t.actualStart as DayDate | null,
      actualFinish: t.actualFinish as DayDate | null,
    })),
    dependencies: s.deps.map((d) => ({ predecessorId: d.pred, successorId: d.succ, type: d.type, lagDays: d.lag })),
  };
}

let derived = derive(state);

function derive(s: PState) {
  const nodes = s.tasks.map((t) => ({ id: t.id, parentId: t.parentId, sort: t.sort }));
  const flat = flattenTree(nodes);
  const { idToWbs, wbsToId } = wbsMaps(nodes);
  const byId = new Map(s.tasks.map((t) => [t.id, t]));
  const hasKids = new Set(s.tasks.filter((t) => t.parentId).map((t) => t.parentId as string));
  const result = schedule(toInput(s));
  return { flat, idToWbs, wbsToId, byId, hasKids, result };
}

const sched = (id: string): TaskSchedule | undefined =>
  derived.result.ok ? derived.result.tasks.get(id) : undefined;

/** Apply a change only if the engine accepts the resulting plan. */
/** The mutator may return a string to refuse the change with that message. */
function commit(mutate: (s: PState) => unknown): boolean {
  const next = structuredClone(state);
  const refusal = mutate(next);
  if (typeof refusal === "string") {
    toast(refusal);
    return false;
  }
  const r = schedule(toInput(next));
  if (!r.ok) {
    toast(describeErrors(r.errors, next));
    return false;
  }
  history.push(JSON.stringify(state));
  if (history.length > 60) history.shift();
  state = next;
  save();
  derived = derive(state);
  render();
  return true;
}

function undo() {
  const prev = history.pop();
  if (!prev) return;
  state = JSON.parse(prev) as PState;
  save();
  derived = derive(state);
  if (view.selected && !derived.byId.has(view.selected)) view.selected = null;
  view.slip = null;
  render();
  toast("Undone");
}

// ── Formatting ───────────────────────────────────────────────────────────────
const dateFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
const longFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" });
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);
const fmt = (d: string) => dateFmt.format(asDate(d)).replace(",", "");
const fmtLong = (d: string) => longFmt.format(asDate(d)).replace(",", "");
const isWeekend = (d: string) => [0, 6].includes(asDate(d).getUTCDay());
const days = (n: number) => `${Math.abs(n)} day${Math.abs(n) === 1 ? "" : "s"}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const wbs = (id: string, s = state) => wbsMaps(s.tasks.map((t) => ({ id: t.id, parentId: t.parentId, sort: t.sort }))).idToWbs.get(id) ?? "?";
const title = (id: string, s = state) => s.tasks.find((t) => t.id === id)?.title ?? "a task";
const ref = (id: string, s = state) => `${wbs(id, s)} ${title(id, s)}`;
const linkLabel = (d: PDep) => `${d.type}${d.lag ? `${d.lag > 0 ? "+" : "−"}${Math.abs(d.lag)}d` : ""}`;

function describeErrors(errors: ScheduleError[], s: PState): string {
  const e = errors[0];
  if (!e) return "That change isn't valid.";
  switch (e.kind) {
    case "dependency_cycle":
      return `That would create a loop: ${[...e.taskIds, e.taskIds[0] as string].map((id) => wbs(id, s)).join(" → ")}. Remove one of those links first.`;
    case "invalid_dependency":
      return `${e.reason} (${wbs(e.predecessorId, s)} → ${wbs(e.successorId, s)}).`;
    case "parent_cycle":
      return "A task can't sit inside its own subtask.";
    case "invalid_task":
      return `${ref(e.taskId, s)}: ${e.reason}.`;
    case "unknown_task":
      return "That link points to a task that no longer exists.";
    case "missing_parent":
      return "That task's group no longer exists.";
    case "duplicate_task":
      return "Two tasks share an id.";
  }
}

function describeWarning(w: ScheduleWarning): string {
  switch (w.kind) {
    case "project_deadline_missed":
      return `The programme finishes ${fmtLong(w.finish)}, ${days(w.daysLate)} after the deadline.`;
    case "deadline_missed":
      return `${ref(w.taskId)} finishes ${fmtLong(w.finish)}, ${days(w.daysLate)} after its own deadline.`;
    case "constraint_conflict":
      return `${ref(w.taskId)} is fixed to ${w.constraintType === "MSO" ? "start" : "finish"} on ${fmtLong(w.constraintDate)}, but its links would start it ${fmtLong(w.drivenStart)}.`;
    case "overrun":
      return `${ref(w.taskId)} was due to finish ${fmtLong(w.plannedFinish)} and is still in progress.`;
    case "summary_field_ignored":
      return `${ref(w.taskId)} is now a group, so its own ${w.field} is ignored.`;
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const rowsEl = $<HTMLTableSectionElement>("#rows");
const detailEl = $<HTMLElement>("#detail");

function visibleRows() {
  const { flat, byId, hasKids } = derived;
  // Filters keep a matching leaf's ancestors so the tree stays readable.
  let keep: Set<string> | null = null;
  if (view.criticalOnly || view.area) {
    keep = new Set();
    for (const r of flat) {
      const t = byId.get(r.node.id);
      if (!t || hasKids.has(t.id)) continue;
      const okCrit = !view.criticalOnly || sched(t.id)?.isCritical;
      const okArea = !view.area || t.area === view.area;
      if (okCrit && okArea) {
        let cur: string | null = t.id;
        while (cur) {
          keep.add(cur);
          cur = byId.get(cur)?.parentId ?? null;
        }
      }
    }
  }
  const out: typeof flat = [];
  let hideBelow: number | null = null;
  for (const r of flat) {
    if (hideBelow !== null && r.depth > hideBelow) continue;
    hideBelow = null;
    if (keep && !keep.has(r.node.id)) continue;
    out.push(r);
    if (view.collapsed.has(r.node.id) && r.hasChildren) hideBelow = r.depth;
  }
  return out;
}

const CARET = `<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;

function render() {
  renderBlock();
  renderBanner();
  const rows = visibleRows();
  rowsEl.innerHTML = rows.map((r) => rowHtml(r.node.id, r.wbs, r.depth, r.hasChildren)).join("") ||
    `<tr><td colspan="10" class="muted" style="padding:16px">No tasks match these filters.</td></tr>`;
  renderDetail();
  ($("#btnUndo") as HTMLButtonElement).disabled = history.length === 0;
  mountEditor();
}

function rowHtml(id: string, code: string, depth: number, summary: boolean): string {
  const t = derived.byId.get(id) as PTask;
  const s = sched(id);
  const status: PStatus = summary
    ? s?.state === "complete" ? "done" : s?.state === "in_progress" ? "in_progress" : "todo"
    : t.status;
  const cls = [
    s?.isCritical ? "critical" : "",
    summary ? "summary" : "",
    view.selected === id ? "selected" : "",
    status === "done" ? "done" : "",
  ].join(" ");
  const ed = (c: Col) => view.editing?.id === id && view.editing.col === c;
  const td = (c: Col, inner: string, extra = "") =>
    ed(c) ? `<td class="cell-edit" data-col="${c}"></td>` : `<td data-col="${c}" ${extra}>${inner}</td>`;

  const isMilestone = !summary && t.duration === 0;
  const lead = summary
    ? `<button class="caret" data-caret="${id}" aria-label="${view.collapsed.has(id) ? "Expand" : "Collapse"} ${esc(t.title)}" aria-expanded="${!view.collapsed.has(id)}">${CARET}</button>`
    : isMilestone ? `<span class="diamond" aria-label="Milestone"></span>` : `<span class="caret-spacer"></span>`;

  const dateCell = (d?: string) => (d ? `<span class="${isWeekend(d) ? "weekend" : ""}" title="${fmtLong(d)}">${fmt(d)}</span>` : "—");

  let floatHtml = `<span class="muted">—</span>`;
  if (s && s.totalFloat !== null) {
    const f = s.totalFloat;
    const w = Math.min(Math.max(f, 0), 20) * 1.4;
    floatHtml = `<span class="float ${f < 0 ? "neg" : f === 0 ? "zero" : ""}">${f > 0 ? `<span class="float-bar" style="width:${w}px"></span>` : ""}${f < 0 ? "−" : ""}${Math.abs(f)}</span>`;
  }

  const preds = state.deps.filter((d) => d.succ === id);
  const predCode = formatPredecessorCode(preds.map((d) => ({ ref: derived.idToWbs.get(d.pred) ?? "?", type: d.type, lagDays: d.lag })));

  return `<tr data-id="${id}" class="${cls}" aria-selected="${view.selected === id}">
    <td class="tape" title="${s?.isCritical ? "On the critical path" : ""}"></td>
    <td class="wbs">${code}</td>
    ${td("title", `<span class="t-cell" style="padding-left:${depth * 18}px">${lead}<span class="t-text">${esc(t.title)}</span></span>`)}
    ${td("area", esc(t.area))}
    ${td("duration", summary ? `<span class="derived">${s?.durationDays ?? 0}</span>` : String(t.duration), `class="num"`)}
    <td>${dateCell(s?.start)}</td>
    <td>${dateCell(s?.finish)}</td>
    <td class="num">${floatHtml}</td>
    ${td("preds", predCode || `<span class="muted">—</span>`)}
    ${td("status", `<span class="pill ${status}">${STATUS_LABEL[status]}</span>`, `class="c-st"`)}
  </tr>`;
}

function renderBlock() {
  const r = derived.result;
  const fin = r.ok ? r.projectFinish : null;
  const dl = state.projectDeadline;
  let margin = `<dd>—</dd>`;
  if (fin && dl) {
    const m = diffDays(fin as DayDate, dl as DayDate);
    margin = m >= 0 ? `<dd class="ok">${days(m)} spare</dd>` : `<dd class="late">${days(m)} late</dd>`;
  }
  const leaves = state.tasks.filter((t) => !derived.hasKids.has(t.id));
  const crit = r.ok ? leaves.filter((t) => r.tasks.get(t.id)?.isCritical).length : 0;
  $("#blockFields").innerHTML = `
    <div><dt><label for="inStart">Start</label></dt><dd><input type="date" id="inStart" value="${state.projectStart}"></dd></div>
    <div><dt>Finish</dt><dd>${fin ? fmt(fin) : "—"}</dd></div>
    <div><dt><label for="inDeadline">Deadline</label></dt><dd><input type="date" id="inDeadline" value="${dl ?? ""}"></dd></div>
    <div><dt>Margin</dt>${margin}</div>
    <div><dt><label for="inStatus">Status date</label></dt><dd><input type="date" id="inStatus" value="${state.statusDate ?? ""}"></dd></div>
    <div><dt>Critical</dt><dd>${crit} of ${leaves.length} tasks</dd></div>`;
}

function renderBanner() {
  const el = $("#banner");
  el.hidden = derived.result.ok;
  if (!derived.result.ok) el.innerHTML = `<strong>The plan can't be scheduled.</strong><span>${esc(describeErrors(derived.result.errors, state))}</span>`;
}

function renderDetail() {
  const warnings = derived.result.ok ? derived.result.warnings : [];
  const warnHtml = `<section><h3>Programme warnings</h3>${
    warnings.length ? `<ul class="warns">${warnings.map((w) => `<li>${esc(describeWarning(w))}</li>`).join("")}</ul>` : `<p class="empty">None. Everything fits its dates.</p>`
  }</section>`;

  const id = view.selected;
  const t = id ? derived.byId.get(id) : undefined;
  if (!id || !t) {
    detailEl.innerHTML = `<section><h2>No task selected</h2><p class="empty">Select a row to see its links, float and what moves if it slips.</p></section>${warnHtml}`;
    return;
  }
  const s = sched(id);
  const summary = derived.hasKids.has(id);
  const kv = (k: string, v: string, cls = "") => `<div><dt>${k}</dt><dd class="${cls}">${v}</dd></div>`;
  const fl = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n < 0 ? "−" : ""}${days(n)}`);

  const linkList = (deps: PDep[], other: (d: PDep) => string) =>
    deps.length
      ? `<ul class="links">${deps.map((d) => `<li><span class="code">${wbs(other(d))}</span><span class="t">${esc(title(other(d)))}</span><span class="lt">${linkLabel(d)}</span></li>`).join("")}</ul>`
      : `<p class="empty">None</p>`;

  const constraint = summary
    ? ""
    : `<section><h3>Constraint and deadline</h3>
        <div class="form-row">
          <label for="inCType">Constraint<select id="inCType">${CONSTRAINT_TYPES.map((c) => `<option value="${c}" ${c === t.constraintType ? "selected" : ""}>${CONSTRAINT_LABEL[c]}</option>`).join("")}</select></label>
          <label for="inCDate">Date<input type="date" id="inCDate" value="${t.constraintDate ?? ""}" ${t.constraintType === "ASAP" ? "disabled" : ""}></label>
        </div>
        <div class="form-row">
          <label for="inTDeadline">Deadline<input type="date" id="inTDeadline" value="${t.deadline ?? ""}"></label>
        </div>
      </section>`;

  detailEl.innerHTML = `
    <section>
      <h2><span class="ref">${wbs(id)}</span>${esc(t.title)}</h2>
      <dl class="kv">
        ${kv("Starts", s ? fmtLong(s.start) : "—")}
        ${kv("Finishes", s ? fmtLong(s.finish) : "—")}
        ${kv("Latest start", s ? fmtLong(s.lateStart) : "—")}
        ${kv("Latest finish", s ? fmtLong(s.lateFinish) : "—")}
        ${kv("Total float", fl(s?.totalFloat), (s?.totalFloat ?? 0) < 0 ? "neg" : "")}
        ${kv("Free float", fl(s?.freeFloat))}
      </dl>
    </section>
    ${summary ? "" : slipHtml(id, t)}
    <section><h3>Comes after</h3>${linkList(state.deps.filter((d) => d.succ === id), (d) => d.pred)}
      <h3>Comes before</h3>${linkList(state.deps.filter((d) => d.pred === id), (d) => d.succ)}</section>
    ${constraint}
    ${warnHtml}`;
}

function slipHtml(id: string, t: PTask): string {
  const delta = view.slip?.id === id ? view.slip.delta : 0;
  let impact = `<p class="empty">Change the days to see what moves before you commit.</p>`;
  if (delta !== 0 && derived.result.ok) {
    const nd = Math.max(0, t.duration + delta);
    const r = schedule(toInput(state, { id, duration: nd }));
    if (r.ok) {
      const changes = diffSchedules(derived.result.tasks, r.tasks)
        .filter((c) => c.finishDelta !== 0 && !derived.hasKids.has(c.taskId))
        .sort((a, b) => (derived.idToWbs.get(a.taskId) ?? "").localeCompare(derived.idToWbs.get(b.taskId) ?? "", undefined, { numeric: true }));
      const pd = diffDays(derived.result.projectFinish, r.projectFinish);
      const late = state.projectDeadline ? diffDays(state.projectDeadline as DayDate, r.projectFinish) : null;
      impact = `${
        changes.length
          ? `<ul class="impact">${changes.map((c) => `<li><span class="code">${wbs(c.taskId)}</span><span class="t">${esc(title(c.taskId))}</span><span class="d ${c.finishDelta > 0 ? "later" : "earlier"}">${c.finishDelta > 0 ? "+" : "−"}${Math.abs(c.finishDelta)}d</span></li>`).join("")}</ul>`
          : `<p class="empty">Nothing else moves. This task has enough float.</p>`
      }<p class="impact-sum ${late !== null && late > 0 ? "late" : ""}">${
        pd === 0 ? "Programme finish stays " + fmtLong(r.projectFinish) + "." : `Programme finish moves ${days(pd)} ${pd > 0 ? "later" : "earlier"}, to ${fmtLong(r.projectFinish)}.`
      }${late !== null && late > 0 ? ` That is ${days(late)} past the deadline.` : ""}</p>`;
    }
  }
  return `<section><h3>What if it takes longer?</h3>
    <div class="slip">
      <span class="stepper"><button type="button" data-slip="-1" aria-label="One day shorter">−</button><output aria-live="polite">${delta > 0 ? "+" : delta < 0 ? "−" : ""}${Math.abs(delta)}d</output><button type="button" data-slip="1" aria-label="One day longer">+</button></span>
      <span class="muted">${t.duration} → ${Math.max(0, t.duration + delta)} days</span>
      ${delta !== 0 ? `<button type="button" class="btn btn-primary" data-slip-apply>Apply</button>` : ""}
    </div>${impact}</section>`;
}

// ── Inline editing ───────────────────────────────────────────────────────────
let editorDone = false;

function mountEditor() {
  if (!view.editing) return;
  const { id, col } = view.editing;
  const cell = rowsEl.querySelector<HTMLTableCellElement>(`tr[data-id="${id}"] td[data-col="${col}"]`);
  const t = derived.byId.get(id);
  if (!cell || !t) {
    view.editing = null;
    return;
  }
  editorDone = false;
  let el: HTMLInputElement | HTMLSelectElement;
  if (col === "area" || col === "status") {
    const sel = document.createElement("select");
    const opts = col === "area" ? AREAS.map((a) => [a, a]) : (Object.keys(STATUS_LABEL) as PStatus[]).map((k) => [k, STATUS_LABEL[k]]);
    sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v as string)}">${esc(l as string)}</option>`).join("");
    sel.value = col === "area" ? t.area : t.status;
    sel.addEventListener("change", () => finishEdit(true));
    el = sel;
  } else {
    const inp = document.createElement("input");
    inp.type = col === "duration" ? "number" : "text";
    if (col === "duration") {
      inp.min = "0";
      inp.max = "3650";
      inp.className = "num";
      inp.value = String(t.duration);
    } else if (col === "preds") {
      inp.placeholder = "e.g. 3.1, 4.2SS+2d";
      inp.value = formatPredecessorCode(state.deps.filter((d) => d.succ === id).map((d) => ({ ref: derived.idToWbs.get(d.pred) ?? "?", type: d.type, lagDays: d.lag })));
    } else {
      inp.value = t.title;
      inp.maxLength = 200;
    }
    el = inp;
  }
  el.id = `edit-${col}`;
  el.setAttribute("aria-label", `Edit ${col === "preds" ? "predecessors" : col}`);
  el.addEventListener("blur", () => finishEdit(true));
  cell.append(el);
  el.focus();
  if (el instanceof HTMLInputElement && el.type === "text") el.select();
}

function startEdit(id: string, col: Col) {
  const summary = derived.hasKids.has(id);
  if (summary && (col === "duration" || col === "status")) {
    toast(col === "duration" ? "A group's length comes from its tasks." : "A group's status comes from its tasks.");
    return;
  }
  view.selected = id;
  view.editing = { id, col };
  render();
}

function finishEdit(save: boolean, move?: 1 | -1) {
  if (editorDone || !view.editing) return;
  editorDone = true;
  const { id, col } = view.editing;
  const el = document.getElementById(`edit-${col}`) as HTMLInputElement | HTMLSelectElement | null;
  const value = el?.value ?? "";
  view.editing = null;
  if (save) applyEdit(id, col, value);
  else render();
  if (move) {
    const editable = COLS.filter((c) => !(derived.hasKids.has(id) && (c === "duration" || c === "status")));
    const next = editable[editable.indexOf(col) + move];
    if (next) startEdit(id, next);
  }
}

function applyEdit(id: string, col: Col, value: string) {
  const t = derived.byId.get(id);
  if (!t) return render();
  const unchanged =
    (col === "title" && value.trim() === t.title) ||
    (col === "area" && value === t.area) ||
    (col === "duration" && Number(value) === t.duration) ||
    (col === "status" && value === t.status);
  if (unchanged) return render();

  const ok = commit((s) => {
    const task = s.tasks.find((x) => x.id === id) as PTask;
    switch (col) {
      case "title":
        if (!value.trim()) return "A task needs a name.";
        task.title = value.trim();
        return;
      case "area":
        task.area = value;
        return;
      case "duration": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 3650) return "Days must be a whole number from 0 to 3650.";
        task.duration = n;
        return;
      }
      case "status":
        return setStatus(task, value as PStatus);
      case "preds":
        return setPreds(s, id, value);
    }
  });
  if (!ok) render();
}

function setStatus(task: PTask, status: PStatus): undefined {
  const s = sched(task.id);
  task.status = status;
  if (status === "todo") {
    task.actualStart = null;
    task.actualFinish = null;
  } else if (status === "in_progress") {
    task.actualStart = task.actualStart ?? s?.start ?? state.projectStart;
    task.actualFinish = null;
  } else {
    task.actualStart = task.actualStart ?? s?.start ?? state.projectStart;
    task.actualFinish = s?.finish ?? task.actualStart;
    if (task.actualFinish < task.actualStart) task.actualFinish = task.actualStart;
  }
}

function setPreds(s: PState, id: string, code: string): string | undefined {
  const parsed = parsePredecessorCode(code);
  if (!parsed.ok) return parsed.error;
  const deps: PDep[] = [];
  for (const p of parsed.value) {
    const pred = derived.wbsToId.get(p.ref);
    if (!pred) return `There's no task ${p.ref}.`;
    if (pred === id) return "A task can't come after itself.";
    deps.push({ id: `d${Math.random().toString(36).slice(2, 9)}`, pred, succ: id, type: p.type, lag: p.lagDays });
  }
  s.deps = s.deps.filter((d) => d.succ !== id).concat(deps);
}

// ── Structure edits ──────────────────────────────────────────────────────────
const siblingsOf = (s: PState, parentId: string | null) =>
  s.tasks.filter((t) => t.parentId === parentId).sort((a, b) => a.sort - b.sort);

function indent(id: string) {
  commit((s) => {
    const t = s.tasks.find((x) => x.id === id) as PTask;
    const sibs = siblingsOf(s, t.parentId);
    const i = sibs.findIndex((x) => x.id === id);
    const above = sibs[i - 1];
    if (!above) return "There's no task above at this level to put it under.";
    const kids = siblingsOf(s, above.id);
    t.parentId = above.id;
    t.sort = (kids.at(-1)?.sort ?? 0) + 1024;
    view.collapsed.delete(above.id);
  });
}

function outdent(id: string) {
  commit((s) => {
    const t = s.tasks.find((x) => x.id === id) as PTask;
    if (!t.parentId) return "It's already at the top level.";
    const parent = s.tasks.find((x) => x.id === t.parentId) as PTask;
    const sibs = siblingsOf(s, parent.parentId);
    const next = sibs[sibs.findIndex((x) => x.id === parent.id) + 1];
    t.parentId = parent.parentId;
    t.sort = sortBetween(parent.sort, next?.sort ?? null);
  });
}

function move(id: string, dir: -1 | 1) {
  commit((s) => {
    const t = s.tasks.find((x) => x.id === id) as PTask;
    const sibs = siblingsOf(s, t.parentId);
    const i = sibs.findIndex((x) => x.id === id);
    const other = sibs[i + dir];
    if (!other) return dir < 0 ? "It's already first in its group." : "It's already last in its group.";
    [t.sort, other.sort] = [other.sort, t.sort];
  });
}

function addTask() {
  const newId = `t${Math.random().toString(36).slice(2, 9)}`;
  const ok = commit((s) => {
    const sel = view.selected ? s.tasks.find((x) => x.id === view.selected) : undefined;
    const parentId = sel?.parentId ?? null;
    const sibs = siblingsOf(s, parentId);
    const next = sel ? sibs[sibs.findIndex((x) => x.id === sel.id) + 1] : undefined;
    s.tasks.push({
      id: newId,
      parentId,
      sort: sel ? sortBetween(sel.sort, next?.sort ?? null) : (sibs.at(-1)?.sort ?? 0) + 1024,
      title: "New task",
      area: sel?.area ?? AREAS[0] ?? "Kitchen",
      duration: 1,
      status: "todo",
      constraintType: "ASAP",
      constraintDate: null,
      deadline: null,
      actualStart: null,
      actualFinish: null,
    });
  });
  if (ok) startEdit(newId, "title");
}

function remove(id: string) {
  const name = title(id);
  const ok = commit((s) => {
    const doomed = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of s.tasks) if (t.parentId && doomed.has(t.parentId) && !doomed.has(t.id)) { doomed.add(t.id); grew = true; }
    }
    s.tasks = s.tasks.filter((t) => !doomed.has(t.id));
    s.deps = s.deps.filter((d) => !doomed.has(d.pred) && !doomed.has(d.succ));
  });
  if (ok) {
    const rows = visibleRows();
    view.selected = rows[0]?.node.id ?? null;
    render();
    toast(`Deleted ${name}. Undo brings it back.`);
  }
}

// ── Events ───────────────────────────────────────────────────────────────────
rowsEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const caret = target.closest<HTMLElement>("[data-caret]");
  if (caret) {
    const id = caret.dataset.caret as string;
    if (view.collapsed.has(id)) view.collapsed.delete(id);
    else view.collapsed.add(id);
    render();
    return;
  }
  const tr = target.closest<HTMLTableRowElement>("tr[data-id]");
  if (!tr || target.closest(".cell-edit")) return;
  const id = tr.dataset.id as string;
  const col = target.closest<HTMLElement>("td[data-col]")?.dataset.col as Col | undefined;
  if (view.selected === id && col) startEdit(id, col);
  else {
    view.selected = id;
    view.slip = null;
    render();
  }
});
rowsEl.addEventListener("dblclick", (e) => {
  const target = e.target as HTMLElement;
  const tr = target.closest<HTMLTableRowElement>("tr[data-id]");
  const col = target.closest<HTMLElement>("td[data-col]")?.dataset.col as Col | undefined;
  if (tr && col && !view.editing) startEdit(tr.dataset.id as string, col);
});

document.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest(".cell-edit")) {
    if (e.key === "Enter") { e.preventDefault(); finishEdit(true); }
    else if (e.key === "Escape") { e.preventDefault(); finishEdit(false); }
    else if (e.key === "Tab") { e.preventDefault(); finishEdit(true, e.shiftKey ? -1 : 1); }
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    if (target.matches("input, select, textarea")) return;
    e.preventDefault();
    undo();
    return;
  }
  if (target.matches("input, select, textarea, button")) return;

  const rows = visibleRows();
  const i = rows.findIndex((r) => r.node.id === view.selected);
  const id = view.selected;
  switch (e.key) {
    case "ArrowDown":
    case "ArrowUp": {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      if (e.altKey && id) return move(id, dir);
      const next = rows[i < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, i + dir))];
      if (next) {
        view.selected = next.node.id;
        view.slip = null;
        render();
        rowsEl.querySelector(`tr[data-id="${next.node.id}"]`)?.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    case "ArrowLeft":
    case "ArrowRight":
      if (id && derived.hasKids.has(id)) {
        e.preventDefault();
        if (e.key === "ArrowLeft") view.collapsed.add(id);
        else view.collapsed.delete(id);
        render();
      }
      return;
    case "Enter":
      e.preventDefault();
      if (e.shiftKey) return addTask();
      if (id) startEdit(id, "title");
      return;
    case "F2":
      if (id) startEdit(id, "title");
      return;
    case "Tab":
      if (!id) return;
      e.preventDefault();
      return e.shiftKey ? outdent(id) : indent(id);
    case "Backspace":
    case "Delete":
      if (id) { e.preventDefault(); remove(id); }
      return;
    case "Escape":
      view.selected = null;
      view.slip = null;
      render();
      return;
  }
});

document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  const v = el.value;
  const dateOrNull = (x: string) => (x && isDayDate(x) ? x : null);
  switch (el.id) {
    case "inStart":
      if (!dateOrNull(v)) { toast("The project needs a start date."); render(); return; }
      commit((s) => { s.projectStart = v; });
      return;
    case "inDeadline":
      commit((s) => {
        if (v && v < s.projectStart) return "The deadline can't be before the start.";
        s.projectDeadline = dateOrNull(v);
      });
      return;
    case "inStatus":
      commit((s) => { s.statusDate = dateOrNull(v); });
      return;
    case "inCType":
      commit((s) => {
        const t = s.tasks.find((x) => x.id === view.selected) as PTask;
        t.constraintType = v as ConstraintType;
        t.constraintDate = v === "ASAP" ? null : t.constraintDate ?? sched(t.id)?.start ?? s.projectStart;
      });
      return;
    case "inCDate":
      commit((s) => {
        const t = s.tasks.find((x) => x.id === view.selected) as PTask;
        if (!dateOrNull(v)) return "This constraint needs a date.";
        t.constraintDate = v;
      });
      return;
    case "inTDeadline":
      commit((s) => {
        const t = s.tasks.find((x) => x.id === view.selected) as PTask;
        t.deadline = dateOrNull(v);
      });
      return;
    case "fCritical":
      view.criticalOnly = (el as HTMLInputElement).checked;
      render();
      return;
    case "fArea":
      view.area = v;
      render();
      return;
  }
});

detailEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const id = view.selected;
  if (!id) return;
  const step = target.closest<HTMLElement>("[data-slip]");
  if (step) {
    const cur = view.slip?.id === id ? view.slip.delta : 0;
    const t = derived.byId.get(id) as PTask;
    const next = Math.max(-t.duration, Math.min(60, cur + Number(step.dataset.slip)));
    view.slip = { id, delta: next };
    renderDetail();
    return;
  }
  if (target.closest("[data-slip-apply]") && view.slip?.id === id) {
    const delta = view.slip.delta;
    view.slip = null;
    commit((s) => {
      const t = s.tasks.find((x) => x.id === id) as PTask;
      t.duration = Math.max(0, t.duration + delta);
    });
  }
});

$("#btnAdd").addEventListener("click", addTask);
$("#btnUndo").addEventListener("click", undo);
$("#btnReset").addEventListener("click", () => {
  history.push(JSON.stringify(state));
  state = sampleState();
  save();
  derived = derive(state);
  view.selected = null;
  view.slip = null;
  view.collapsed.clear();
  render();
  toast("Sample programme restored. Undo brings your version back.");
});

let toastTimer = 0;
function toast(msg: string) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, 4200);
}

// ── Boot ─────────────────────────────────────────────────────────────────────
($("#fArea") as HTMLSelectElement).insertAdjacentHTML("beforeend", AREAS.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join(""));
render();
