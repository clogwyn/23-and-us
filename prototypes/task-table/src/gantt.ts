/**
 * Gantt: one row per visible task (same filters and collapse as the table).
 *  - bar = scheduled start..finish; critical bars in mustard; complete in olive
 *  - thin tail after a bar = total float (how far it can slip)
 *  - arrows = dependency links, drawn from the side each link type reads
 *  - drag a bar to move its start (sets "start no earlier than"); drag its right edge to change days
 */
import { fromEpochDay, toEpochDay, type DayDate } from "@23andus/domain";
import type { ViewCtx } from "./ctx.ts";
import type { PState } from "./model.ts";
import { beginPointerDrag, consumeDragClick, ghost } from "./drag.ts";

const ROW = 30;
const HEAD = 44;
const LABEL_W = 270;
type Scale = "day" | "week";
let scale: Scale = "day";
const PX: Record<Scale, number> = { day: 26, week: 9 };

const monthFmt = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const ep = (d: string) => toEpochDay(d as DayDate);
const dayOfWeek = (n: number) => new Date(n * 86_400_000).getUTCDay();

interface Geo { d0: number; px: number; x(day: number): number }

export function renderGantt(host: HTMLElement, ctx: ViewCtx): void {
  const r = ctx.result();
  if (!r.ok) { host.innerHTML = `<p class="empty" style="padding:16px">The plan can't be scheduled, so there's nothing to draw yet.</p>`; return; }
  const rows = ctx.rows();
  const st = ctx.state();
  const px = PX[scale];

  // Range: a couple of days before the start to a week after the latest relevant date.
  let lo = ep(st.projectStart);
  let hi = ep(r.projectFinish);
  for (const s of r.tasks.values()) { lo = Math.min(lo, ep(s.start)); hi = Math.max(hi, ep(s.lateFinish)); }
  if (st.projectDeadline) hi = Math.max(hi, ep(st.projectDeadline));
  const d0 = lo - 2;
  const d1 = hi + 8;
  const span = d1 - d0;
  const geo: Geo = { d0, px, x: (day) => (day - d0) * px };
  const width = span * px;
  const height = rows.length * ROW;

  // Header: months, then days (or week-commencing Mondays).
  let months = "";
  for (let d = d0; d < d1;) {
    const date = new Date(d * 86_400_000);
    const next = Math.min(d1, Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 86_400_000);
    months += `<div class="g-month" style="left:${geo.x(d)}px;width:${(next - d) * px}px"><span>${monthFmt.format(date)}</span></div>`;
    d = next;
  }
  let ticks = "";
  let shade = "";
  for (let d = d0; d < d1; d++) {
    const dow = dayOfWeek(d);
    if (dow === 0 || dow === 6) shade += `<div class="g-weekend" style="left:${geo.x(d)}px;width:${px}px"></div>`;
    if (scale === "day") ticks += `<div class="g-day ${dow === 0 || dow === 6 ? "we" : ""}" style="left:${geo.x(d)}px;width:${px}px">${new Date(d * 86_400_000).getUTCDate()}</div>`;
    else if (dow === 1) ticks += `<div class="g-day wk" style="left:${geo.x(d)}px;width:${7 * px}px">${new Date(d * 86_400_000).getUTCDate()}</div>`;
  }

  // Marker lines.
  const lines: string[] = [];
  if (st.statusDate) lines.push(`<div class="g-line status" style="left:${geo.x(ep(st.statusDate))}px" title="Status date ${ctx.fmtLong(st.statusDate)}"><span>Status</span></div>`);
  if (st.projectDeadline) lines.push(`<div class="g-line deadline" style="left:${geo.x(ep(st.projectDeadline) + 1)}px" title="Deadline ${ctx.fmtLong(st.projectDeadline)}"><span>Deadline</span></div>`);

  // Rows: labels + bars.
  const index = new Map<string, number>();
  let labels = "";
  let bars = "";
  rows.forEach((row, i) => {
    const id = row.node.id;
    index.set(id, i);
    const t = ctx.byId(id);
    const s = r.tasks.get(id);
    if (!t || !s) return;
    const y = i * ROW;
    const summary = ctx.isSummary(id);
    const sel = ctx.selected() === id ? "selected" : "";
    labels += `<div class="g-label ${summary ? "summary" : ""} ${sel} ${s.isCritical ? "critical" : ""}" data-row="${id}" style="top:${y}px">
      <span class="wbs">${row.wbs}</span>
      <span class="g-name" style="padding-left:${row.depth * 14}px">${summary ? `<button class="caret" data-caret="${id}" aria-expanded="${row.hasChildren}" aria-label="Collapse or expand ${ctx.esc(t.title)}">▾</button>` : ""}${ctx.esc(t.title)}</span>
    </div>`;
    bars += `<div class="g-rowbg ${sel}" style="top:${y}px"></div>`;

    const xs = geo.x(ep(s.start));
    const xe = geo.x(ep(s.finish) + 1);
    const tip = `${ctx.wbs(id)} ${t.title}: ${s.durationDays === 0 ? ctx.fmtLong(s.start) : `${ctx.fmtLong(s.start)} to ${ctx.fmtLong(s.finish)}`}`;
    if (summary) {
      bars += `<div class="g-summary ${s.isCritical ? "critical" : ""}" style="left:${xs}px;width:${Math.max(xe - xs, 2)}px;top:${y + 11}px" title="${ctx.esc(tip)}"></div>`;
    } else if (s.isMilestone) {
      bars += `<div class="g-ms ${s.isCritical ? "critical" : ""} ${s.state === "complete" ? "done" : ""}" data-bar="${id}" data-ms="1" style="left:${xs - 7}px;top:${y + 8}px" title="${ctx.esc(tip)}"></div>`;
    } else {
      if (s.totalFloat !== null && s.totalFloat > 0) {
        const xl = geo.x(ep(s.lateFinish) + 1);
        bars += `<div class="g-float" style="left:${xe}px;width:${xl - xe}px;top:${y + 14}px" title="${s.totalFloat} days of float"></div>`;
      }
      const cls = s.state === "complete" ? "done" : s.isCritical ? "critical" : "";
      bars += `<div class="g-bar ${cls} ${sel}" data-bar="${id}" style="left:${xs}px;width:${xe - xs}px;top:${y + 7}px" title="${ctx.esc(tip)}">
        ${t.status === "in_progress" ? `<span class="g-prog"></span>` : ""}<span class="g-grip" aria-hidden="true"></span></div>`;
    }
  });

  // Arrows.
  const paths: string[] = [];
  for (const d of st.deps) {
    const a = index.get(d.pred);
    const b = index.get(d.succ);
    const sp = r.tasks.get(d.pred);
    const ss = r.tasks.get(d.succ);
    if (a === undefined || b === undefined || !sp || !ss) continue;
    const fromStart = d.type === "SS" || d.type === "SF";
    const toStart = d.type === "FS" || d.type === "SS";
    const x1 = fromStart ? geo.x(ep(sp.start)) : geo.x(ep(sp.finish) + (sp.isMilestone ? 0 : 1));
    const x2 = toStart ? geo.x(ep(ss.start)) : geo.x(ep(ss.finish) + (ss.isMilestone ? 0 : 1));
    const y1 = a * ROW + ROW / 2;
    const y2 = b * ROW + ROW / 2;
    const ymid = y2 + (y2 > y1 ? -ROW / 2 : ROW / 2);
    let path: string;
    if (d.type === "SS") path = `M${x1},${y1} H${Math.min(x1, x2) - 7} V${y2} H${x2}`;
    else if (d.type === "FF") path = `M${x1},${y1} H${Math.max(x1, x2) + 7} V${y2} H${x2}`;
    else if (d.type === "FS" && x2 - x1 >= 14) path = `M${x1},${y1} H${x1 + 7} V${y2} H${x2}`;
    else {
      // Leads, and SF: step out, run along the gap between rows, step in.
      const out = x1 + (fromStart ? -7 : 7);
      const inn = x2 + (toStart ? -7 : 7);
      path = `M${x1},${y1} H${out} V${ymid} H${inn} V${y2} H${x2}`;
    }
    const crit = sp.isCritical && ss.isCritical;
    paths.push(`<path d="${path}" class="${crit ? "crit" : ""}" marker-end="url(#${crit ? "ahc" : "ah"})"/>`);
  }

  host.innerHTML = `
    <div class="g-tools">
      <span class="seg" role="group" aria-label="Zoom">
        <button type="button" data-scale="day" aria-pressed="${scale === "day"}">Days</button>
        <button type="button" data-scale="week" aria-pressed="${scale === "week"}">Weeks</button>
      </span>
      <span class="g-key"><i class="k-bar"></i>Task <i class="k-crit"></i>Critical <i class="k-float"></i>Float <i class="k-ms"></i>Milestone</span>
    </div>
    <div class="g-scroll" id="gScroll">
      <div class="g-canvas" style="width:${LABEL_W + width}px;height:${HEAD + height}px">
        <div class="g-head" style="left:${LABEL_W}px;width:${width}px">${months}<div class="g-days">${ticks}</div></div>
        <div class="g-corner" style="width:${LABEL_W}px;height:${HEAD}px"><span>Task</span></div>
        <div class="g-body" style="left:${LABEL_W}px;top:${HEAD}px;width:${width}px;height:${height}px">
          ${shade}${bars}${lines.join("")}
          <svg class="g-links" width="${width}" height="${height}" aria-hidden="true">
            <defs>
              <marker id="ah" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z"/></marker>
              <marker id="ahc" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z" class="crit"/></marker>
            </defs>${paths.join("")}
          </svg>
        </div>
        <div class="g-labels" style="width:${LABEL_W}px;height:${height}px">${labels}</div>
      </div>
    </div>`;
}

export function wireGantt(host: HTMLElement, ctx: ViewCtx & {
  toggle(id: string): void;
  scheduleOf(s: PState): ReturnType<ViewCtx["result"]>;
}, rerender: () => void): void {
  host.addEventListener("click", (e) => {
    if (consumeDragClick()) return;
    const el = e.target as HTMLElement;
    const z = el.closest<HTMLElement>("[data-scale]");
    if (z) {
      const sc = host.querySelector<HTMLElement>("#gScroll");
      const frac = sc ? (sc.scrollLeft + sc.clientWidth / 2) / sc.scrollWidth : 0;
      scale = z.dataset.scale as Scale;
      rerender();
      const sc2 = host.querySelector<HTMLElement>("#gScroll");
      if (sc2) sc2.scrollLeft = frac * sc2.scrollWidth - sc2.clientWidth / 2;
      return;
    }
    const caret = el.closest<HTMLElement>("[data-caret]");
    if (caret) { ctx.toggle(caret.dataset.caret as string); return; }
    const hit = el.closest<HTMLElement>("[data-row],[data-bar]");
    if (hit) { ctx.select(hit.dataset.row ?? hit.dataset.bar ?? null); rerender(); }
  });

  host.addEventListener("pointerdown", (down) => {
    const bar = (down.target as HTMLElement).closest<HTMLElement>("[data-bar]");
    if (!bar) return;
    const id = bar.dataset.bar as string;
    const t = ctx.byId(id);
    const s = ctx.sched(id);
    if (!t || !s) return;
    const px = PX[scale];
    const rect = bar.getBoundingClientRect();
    const resize = !bar.dataset.ms && down.clientX > rect.right - 9;
    const w0 = rect.width;
    let g: ReturnType<typeof ghost> | null = null;
    let days = 0;

    beginPointerDrag(down, {
      onStart(e) {
        if (s.state === "complete") return;
        bar.classList.add("dragging");
        g = ghost("");
        g.at(e);
      },
      onMove(e, dx) {
        if (s.state === "complete") return;
        days = Math.round(dx / px);
        if (resize) {
          const nd = Math.max(1, t.duration + days);
          days = nd - t.duration;
          bar.style.width = `${nd * px}px`;
          if (g) g.el.textContent = `${nd} days, finishes ${ctx.fmt(fromEpochDay(ep(s.start) + nd - 1))}`;
        } else {
          bar.style.transform = `translateX(${days * px}px)`;
          if (g) g.el.textContent = `Starts ${ctx.fmt(fromEpochDay(ep(s.start) + days))}`;
        }
        g?.at(e);
      },
      onDrop() {
        g?.remove();
        bar.classList.remove("dragging");
        bar.style.transform = "";
        bar.style.width = `${w0}px`;
        if (s.state === "complete") { ctx.toast("Completed tasks are history and can't be moved. Set it back to In progress first."); return; }
        if (days === 0) return;
        if (resize) {
          ctx.commit((st) => {
            const x = st.tasks.find((k) => k.id === id);
            if (x) x.duration = Math.max(1, x.duration + days);
          });
          return;
        }
        moveStart(id, days, ctx);
      },
      onCancel() {
        g?.remove();
        bar.classList.remove("dragging");
        bar.style.transform = "";
        bar.style.width = `${w0}px`;
      },
    });
  });
}

/** Move a task's start by `days`, expressed as the least constraint that achieves it. */
function moveStart(id: string, days: number, ctx: ViewCtx & { scheduleOf(s: PState): ReturnType<ViewCtx["result"]> }) {
  const st = ctx.state();
  const t = st.tasks.find((k) => k.id === id);
  const s = ctx.sched(id);
  if (!t || !s) return;
  const newStart = fromEpochDay(ep(s.start) + days);

  // Pinned tasks keep their pin, just on a new date.
  if (t.constraintType === "MSO" || t.constraintType === "MFO") {
    ctx.commit((n) => {
      const x = n.tasks.find((k) => k.id === id);
      if (!x || !x.constraintDate) return "That task no longer exists.";
      x.constraintDate = fromEpochDay(ep(x.constraintDate) + days);
    });
    return;
  }

  // Where would links alone put it?
  const asap = structuredClone(st);
  const ax = asap.tasks.find((k) => k.id === id);
  if (!ax) return;
  ax.constraintType = "ASAP";
  ax.constraintDate = null;
  const ra = ctx.scheduleOf(asap);
  const driven = ra.ok ? ra.tasks.get(id)?.start : undefined;
  if (!driven) return;

  if (newStart < driven) {
    const preds = st.deps.filter((d) => d.succ === id).map((d) => st.tasks.find((k) => k.id === d.pred)?.title).filter(Boolean);
    ctx.toast(`${t.title} can't start before ${ctx.fmtLong(driven)}${preds.length ? `: it comes after ${preds.slice(0, 2).join(" and ")}` : st.statusDate ? " (the status date)" : " (the project start)"}.`);
    return;
  }
  const ok = ctx.commit((n) => {
    const x = n.tasks.find((k) => k.id === id);
    if (!x) return "That task no longer exists.";
    if (newStart === driven) { x.constraintType = "ASAP"; x.constraintDate = null; }
    else { x.constraintType = "SNET"; x.constraintDate = newStart; }
  });
  if (ok && newStart !== driven) ctx.toast(`${t.title} now starts no earlier than ${ctx.fmtLong(newStart)}.`);
}
