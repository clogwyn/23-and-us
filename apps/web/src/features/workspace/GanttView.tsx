"use client";
/**
 * Gantt: same rows, filters and collapse as the table.
 *  bar = scheduled dates · mustard = critical · olive = done · thin tail = float
 *  arrows = links, drawn from the side each link type reads · dashed lines = today, deadline, due dates
 *  drag a bar to move its start; drag its right edge to change its length.
 */
import { useRef, useState } from "react";
import { fromEpochDay, toEpochDay, type DayDate } from "@23andus/domain";
import { useWS, visibleRows } from "./context";
import { fmt, fmtLong } from "./format";
import { moveStart, resize } from "./ops";
import { beginPointerDrag, consumeDragClick, ghost } from "./drag";

const ROW = 30;
const HEAD = 44;
const LABEL_W = 270;
type Scale = "day" | "week";
const PX: Record<Scale, number> = { day: 26, week: 9 };
const monthFmt = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const ep = (d: string) => toEpochDay(d as DayDate);
const dow = (n: number) => new Date(n * 86_400_000).getUTCDay();

export function GanttView() {
  const ws = useWS();
  const { store, view, setView } = ws;
  const [scale, setScale] = useState<Scale>("day");
  const scroller = useRef<HTMLDivElement>(null);
  const r = store.derived.result;
  if (!r.ok) return <p className="empty" style={{ padding: 16 }}>The plan can't be scheduled, so there's nothing to draw yet.</p>;

  const rows = visibleRows(ws);
  const p = store.state.project;
  const px = PX[scale];
  let lo = ep(p.startDate);
  let hi = ep(r.projectFinish);
  for (const s of r.tasks.values()) { lo = Math.min(lo, ep(s.start)); hi = Math.max(hi, ep(s.lateFinish)); }
  if (p.deadline) hi = Math.max(hi, ep(p.deadline));
  const today = ep(store.derived.statusDate);
  const d0 = lo - 2;
  const d1 = hi + 8;
  const x = (day: number) => (day - d0) * px;
  const width = (d1 - d0) * px;
  const height = rows.length * ROW;

  const months: React.ReactNode[] = [];
  for (let d = d0; d < d1;) {
    const date = new Date(d * 86_400_000);
    const next = Math.min(d1, Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 86_400_000);
    months.push(<div key={d} className="g-month" style={{ left: x(d), width: (next - d) * px }}><span>{monthFmt.format(date)}</span></div>);
    d = next;
  }
  const ticks: React.ReactNode[] = [];
  const shade: React.ReactNode[] = [];
  for (let d = d0; d < d1; d++) {
    const w = dow(d);
    if (w === 0 || w === 6) shade.push(<div key={d} className="g-weekend" style={{ left: x(d), width: px }} />);
    if (scale === "day") ticks.push(<div key={d} className={`g-day ${w === 0 || w === 6 ? "we" : ""}`} style={{ left: x(d), width: px }}>{new Date(d * 86_400_000).getUTCDate()}</div>);
    else if (w === 1) ticks.push(<div key={d} className="g-day wk" style={{ left: x(d), width: 7 * px }}>{new Date(d * 86_400_000).getUTCDate()}</div>);
  }

  const index = new Map(rows.map((row, i) => [row.node.id, i]));
  const paths: React.ReactNode[] = [];
  for (const d of store.state.deps) {
    const a = index.get(d.pred);
    const b = index.get(d.succ);
    const sp = r.tasks.get(d.pred);
    const ss = r.tasks.get(d.succ);
    if (a === undefined || b === undefined || !sp || !ss) continue;
    const fromStart = d.type === "SS" || d.type === "SF";
    const toStart = d.type === "FS" || d.type === "SS";
    const x1 = fromStart ? x(ep(sp.start)) : x(ep(sp.finish) + (sp.isMilestone ? 0 : 1));
    const x2 = toStart ? x(ep(ss.start)) : x(ep(ss.finish) + (ss.isMilestone ? 0 : 1));
    const y1 = a * ROW + ROW / 2;
    const y2 = b * ROW + ROW / 2;
    const ymid = y2 + (y2 > y1 ? -ROW / 2 : ROW / 2);
    let path: string;
    if (d.type === "SS") path = `M${x1},${y1} H${Math.min(x1, x2) - 7} V${y2} H${x2}`;
    else if (d.type === "FF") path = `M${x1},${y1} H${Math.max(x1, x2) + 7} V${y2} H${x2}`;
    else if (d.type === "FS" && x2 - x1 >= 14) path = `M${x1},${y1} H${x1 + 7} V${y2} H${x2}`;
    else path = `M${x1},${y1} H${x1 + (fromStart ? -7 : 7)} V${ymid} H${x2 + (toStart ? -7 : 7)} V${y2} H${x2}`;
    const crit = sp.isCritical && ss.isCritical;
    paths.push(<path key={d.id} d={path} className={crit ? "crit" : ""} markerEnd={`url(#${crit ? "ahc" : "ah"})`} />);
  }

  const onBarDown = (e: React.PointerEvent<HTMLElement>, id: string, milestone: boolean) => {
    const bar = e.currentTarget;
    const t = store.task(id);
    const s = store.sched(id);
    if (!t || !s) return;
    const rect = bar.getBoundingClientRect();
    const isResize = !milestone && e.clientX > rect.right - 9;
    const w0 = bar.style.width;
    let g: ReturnType<typeof ghost> | null = null;
    let delta = 0;
    const reset = () => { g?.remove(); bar.classList.remove("dragging"); bar.style.transform = ""; bar.style.width = w0; };
    beginPointerDrag(e.nativeEvent, {
      onStart(ev) { if (s.state === "complete") return; bar.classList.add("dragging"); g = ghost(""); g.at(ev); },
      onMove(ev, dx) {
        if (s.state === "complete") return;
        delta = Math.round(dx / px);
        if (isResize) {
          const nd = Math.max(1, t.duration + delta);
          delta = nd - t.duration;
          bar.style.width = `${nd * px}px`;
          if (g) g.el.textContent = `${nd} days, finishes ${fmt(fromEpochDay(ep(s.start) + nd - 1))}`;
        } else {
          bar.style.transform = `translateX(${delta * px}px)`;
          if (g) g.el.textContent = `Starts ${fmt(fromEpochDay(ep(s.start) + delta))}`;
        }
        g?.at(ev);
      },
      onDrop() {
        reset();
        if (s.state === "complete") { ws.toast("Completed tasks are history and can't be moved. Set it back to In progress first."); return; }
        if (delta === 0) return;
        if (isResize) resize(store, id, delta);
        else { const m = moveStart(store, id, delta); if (m) ws.toast(m); }
      },
      onCancel: reset,
    });
  };

  const onClick = (e: React.MouseEvent) => {
    if (consumeDragClick()) return;
    const el = e.target as HTMLElement;
    const caret = el.closest<HTMLElement>("[data-caret]");
    if (caret) {
      const id = caret.dataset.caret as string;
      setView((v) => { const c = new Set(v.collapsed); if (c.has(id)) c.delete(id); else c.add(id); return { collapsed: c }; });
      return;
    }
    const hit = el.closest<HTMLElement>("[data-row],[data-bar]");
    if (hit) setView({ selected: hit.dataset.row ?? hit.dataset.bar ?? null });
  };

  const zoom = (next: Scale) => {
    const sc = scroller.current;
    const frac = sc ? (sc.scrollLeft + sc.clientWidth / 2) / sc.scrollWidth : 0;
    setScale(next);
    requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollLeft = frac * scroller.current.scrollWidth - scroller.current.clientWidth / 2; });
  };

  return (
    <div className="gantt-wrap" onClick={onClick}>
      <div className="g-tools">
        <span className="seg" role="group" aria-label="Zoom">
          <button type="button" aria-pressed={scale === "day"} onClick={() => zoom("day")}>Days</button>
          <button type="button" aria-pressed={scale === "week"} onClick={() => zoom("week")}>Weeks</button>
        </span>
        <span className="g-key"><i className="k-bar" />Task <i className="k-crit" />Critical <i className="k-float" />Float <i className="k-ms" />Milestone</span>
      </div>
      <div className="g-scroll" ref={scroller}>
        <div className="g-canvas" style={{ width: LABEL_W + width, height: HEAD + height }}>
          <div className="g-head" style={{ left: LABEL_W, width }}>{months}<div className="g-days">{ticks}</div></div>
          <div className="g-corner" style={{ width: LABEL_W, height: HEAD }}><span>Task</span></div>
          <div className="g-body" style={{ left: LABEL_W, top: HEAD, width, height }}>
            {shade}
            {rows.map((row, i) => {
              const id = row.node.id;
              const t = store.task(id);
              const s = r.tasks.get(id);
              if (!t || !s) return null;
              const y = i * ROW;
              const sel = view.selected === id ? "selected" : "";
              const xs = x(ep(s.start));
              const xe = x(ep(s.finish) + 1);
              const tip = `${store.wbs(id)} ${t.title}: ${s.durationDays === 0 ? fmtLong(s.start) : `${fmtLong(s.start)} to ${fmtLong(s.finish)}`}`;
              return (
                <div key={id}>
                  <div className={`g-rowbg ${sel}`} style={{ top: y }} />
                  {row.hasChildren ? (
                    <div className={`g-summary ${s.isCritical ? "critical" : ""}`} style={{ left: xs, width: Math.max(xe - xs, 2), top: y + 11 }} title={tip} />
                  ) : s.isMilestone ? (
                    <div className={`g-ms ${s.isCritical ? "critical" : ""} ${s.state === "complete" ? "done" : ""}`} data-bar={id} style={{ left: xs - 7, top: y + 8 }} title={tip} onPointerDown={(e) => onBarDown(e, id, true)} />
                  ) : (
                    <>
                      {s.totalFloat !== null && s.totalFloat > 0 && (
                        <div className="g-float" style={{ left: xe, width: x(ep(s.lateFinish) + 1) - xe, top: y + 14 }} title={`${s.totalFloat} days of float`} />
                      )}
                      <div
                        className={`g-bar ${s.state === "complete" ? "done" : s.isCritical ? "critical" : ""} ${sel}`}
                        data-bar={id}
                        style={{ left: xs, width: xe - xs, top: y + 7 }}
                        title={tip}
                        onPointerDown={(e) => onBarDown(e, id, false)}
                      >
                        {t.status === "in_progress" && <span className="g-prog" />}
                        <span className="g-grip" aria-hidden="true" />
                      </div>
                    </>
                  )}
                  {t.deadline && !row.hasChildren && (
                    <div className={`g-due ${s.finish > t.deadline ? "late" : ""}`} style={{ left: x(ep(t.deadline) + 1) - 1, top: y + 4 }} title={`Due ${fmtLong(t.deadline)}`} />
                  )}
                </div>
              );
            })}
            {today >= d0 && today < d1 && <div className="g-line status" style={{ left: x(today) }}><span>Today</span></div>}
            {p.deadline && <div className="g-line deadline" style={{ left: x(ep(p.deadline) + 1) }}><span>Deadline</span></div>}
            <svg className="g-links" width={width} height={height} aria-hidden="true">
              <defs>
                <marker id="ah" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z" /></marker>
                <marker id="ahc" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z" className="crit" /></marker>
              </defs>
              {paths}
            </svg>
          </div>
          <div className="g-labels" style={{ width: LABEL_W, height }}>
            {rows.map((row, i) => {
              const id = row.node.id;
              const t = store.task(id);
              const s = r.tasks.get(id);
              if (!t) return null;
              return (
                <div key={id} className={`g-label ${row.hasChildren ? "summary" : ""} ${view.selected === id ? "selected" : ""} ${s?.isCritical ? "critical" : ""}`} data-row={id} style={{ top: i * ROW }}>
                  <span className="wbs">{row.wbs}</span>
                  <span className="g-name" style={{ paddingLeft: row.depth * 14 }}>
                    {row.hasChildren && <button className="caret" data-caret={id} aria-expanded={!view.collapsed.has(id)} aria-label={`Collapse or expand ${t.title}`}>▾</button>}
                    {t.title}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
