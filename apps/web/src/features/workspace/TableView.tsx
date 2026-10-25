"use client";
import { useEffect, useRef } from "react";
import { formatPredecessorCode, isDayDate } from "@23andus/domain";
import { useWS, visibleRows, type WS } from "./context";
import { BOARD_STATUSES, STATUS_LABEL, type Status } from "./types";
import { fmt, fmtLong, isWeekend, money } from "./format";
import { dropRow, setPreds, setStatus } from "./ops";
import { beginPointerDrag, consumeDragClick, ghost } from "./drag";

type Col = "title" | "area" | "duration" | "due" | "preds" | "status";
const COLS: Col[] = ["title", "area", "duration", "due", "preds", "status"];

export function TableView() {
  const ws = useWS();
  const { store, view, setView } = ws;
  const rows = visibleRows(ws);

  // Cost roll-up: each task's own lines plus everything beneath it.
  const own = new Map<string, { est: number; act: number }>();
  for (const c of store.state.costs) {
    if (!c.taskId) continue;
    const o = own.get(c.taskId) ?? { est: 0, act: 0 };
    o.est += c.estimate ?? 0;
    o.act += c.actual ?? 0;
    own.set(c.taskId, o);
  }
  const rolled = new Map<string, { est: number; act: number }>();
  for (const t of store.state.tasks) {
    const o = own.get(t.id);
    if (!o) continue;
    for (let cur: string | null = t.id; cur; cur = store.task(cur)?.parentId ?? null) {
      const r = rolled.get(cur) ?? { est: 0, act: 0 };
      r.est += o.est;
      r.act += o.act;
      rolled.set(cur, r);
    }
  }

  const onRowPointerDown = (e: React.PointerEvent, id: string) => {
    if (!(e.target as HTMLElement).closest("[data-grip]")) return;
    startRowDrag(e.nativeEvent, id, ws);
  };

  return (
    <div className="table-wrap">
      <table className="grid wide">
        <colgroup>
          <col className="c-tape" /><col className="c-wbs" /><col className="c-title" /><col className="c-area" /><col className="c-dur" />
          <col className="c-date" /><col className="c-date" /><col className="c-date" /><col className="c-float" /><col className="c-pred" />
          <col className="c-money" /><col className="c-money" /><col className="c-status" />
        </colgroup>
        <thead>
          <tr>
            <th className="tape" aria-hidden="true" />
            <th>WBS</th><th>Task</th><th>Area</th><th className="num">Days</th>
            <th>Start</th><th>Finish</th><th>Due</th><th className="num">Float</th><th>Predecessors</th>
            <th className="num">Estimate</th><th className="num">Actual</th><th>Status</th>
          </tr>
        </thead>
        <tbody
          onClick={(e) => {
            if (consumeDragClick()) return;
            const el = e.target as HTMLElement;
            const caret = el.closest<HTMLElement>("[data-caret]");
            if (caret) {
              const id = caret.dataset.caret as string;
              setView((v) => { const c = new Set(v.collapsed); if (c.has(id)) c.delete(id); else c.add(id); return { collapsed: c }; });
              return;
            }
            const tr = el.closest<HTMLElement>("tr[data-id]");
            if (!tr || el.closest(".cell-edit")) return;
            const id = tr.dataset.id as string;
            const col = el.closest<HTMLElement>("td[data-col]")?.dataset.col as Col | undefined;
            if (view.selected === id && col) startEdit(ws, id, col);
            else setView({ selected: id, editing: null });
          }}
          onDoubleClick={(e) => {
            const el = e.target as HTMLElement;
            const tr = el.closest<HTMLElement>("tr[data-id]");
            const col = el.closest<HTMLElement>("td[data-col]")?.dataset.col as Col | undefined;
            if (tr && col && !view.editing) startEdit(ws, tr.dataset.id as string, col);
          }}
        >
          {rows.length === 0 && (
            <tr><td colSpan={13} className="muted" style={{ padding: 16 }}>No tasks match these filters.</td></tr>
          )}
          {rows.map((r) => {
            const id = r.node.id;
            const t = store.task(id);
            if (!t) return null;
            const s = store.sched(id);
            const summary = r.hasChildren;
            const status: Status = summary ? (s?.state === "complete" ? "done" : s?.state === "in_progress" ? "in_progress" : "todo") : t.status;
            const ed = (c: Col) => view.editing?.id === id && view.editing.col === c;
            const cell = (c: Col, inner: React.ReactNode, cls = "") =>
              ed(c) ? <td key={c} className="cell-edit" data-col={c}><Editor id={id} col={c} /></td> : <td key={c} data-col={c} className={cls}>{inner}</td>;
            const preds = store.state.deps.filter((d) => d.succ === id);
            const predCode = formatPredecessorCode(preds.map((d) => ({ ref: store.wbs(d.pred), type: d.type, lagDays: d.lag })));
            const money2 = rolled.get(id);
            const late = t.deadline && s && s.finish > t.deadline;
            const dateCell = (d?: string) => (d ? <span className={isWeekend(d) ? "weekend" : ""} title={fmtLong(d)}>{fmt(d)}</span> : "—");
            const f = s?.totalFloat ?? null;
            return (
              <tr
                key={id}
                data-id={id}
                aria-selected={view.selected === id}
                className={[s?.isCritical && "critical", summary && "summary", view.selected === id && "selected", status === "done" && "done", t.status === "cancelled" && "cancelled"].filter(Boolean).join(" ")}
                onPointerDown={(e) => onRowPointerDown(e, id)}
              >
                <td className="tape" title={s?.isCritical ? "On the critical path" : undefined} />
                <td className="wbs"><span className="grip" data-grip={id} title="Drag to move" aria-hidden="true" />{r.wbs}</td>
                {cell("title", (
                  <span className="t-cell" style={{ paddingLeft: r.depth * 18 }}>
                    {summary ? (
                      <button className="caret" data-caret={id} aria-expanded={!view.collapsed.has(id)} aria-label={`${view.collapsed.has(id) ? "Expand" : "Collapse"} ${t.title}`}>
                        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
                      </button>
                    ) : t.duration === 0 ? <span className="diamond" aria-label="Milestone" /> : <span className="caret-spacer" />}
                    <span className="t-text">{t.title}</span>
                  </span>
                ))}
                {cell("area", ws.areas.find((a) => a.id === t.areaId)?.name ?? <span className="muted">—</span>)}
                {cell("duration", summary ? <span className="derived">{s?.durationDays ?? 0}</span> : t.duration, "num")}
                <td>{dateCell(s?.start)}</td>
                <td>{dateCell(s?.finish)}</td>
                {cell("due", t.deadline ? <span className={late ? "due-late" : ""} title={late ? "Finishes after it's due" : undefined}>{fmt(t.deadline)}</span> : <span className="muted">—</span>)}
                <td className="num">
                  {f === null ? <span className="muted">—</span> : (
                    <span className={`float ${f < 0 ? "neg" : f === 0 ? "zero" : ""}`}>
                      {f > 0 && <span className="float-bar" style={{ width: Math.min(f, 20) * 1.4 }} />}
                      {f < 0 ? "−" : ""}{Math.abs(f)}
                    </span>
                  )}
                </td>
                {cell("preds", predCode || <span className="muted">—</span>)}
                <td className={`num money ${summary ? "derived" : ""}`}>{money2?.est ? money(money2.est) : <span className="muted">—</span>}</td>
                <td className={`num money ${summary ? "derived" : ""} ${money2 && money2.est && money2.act > money2.est ? "over" : ""}`}>{money2?.act ? money(money2.act) : <span className="muted">—</span>}</td>
                {cell("status", <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>, "c-st")}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function startEdit(ws: WS, id: string, col: Col) {
  if (ws.store.isSummary(id) && (col === "duration" || col === "status")) {
    ws.toast(col === "duration" ? "A group's length comes from its tasks." : "A group's status comes from its tasks.");
    return;
  }
  ws.setView({ selected: id, editing: { id, col } });
}

function Editor({ id, col }: { id: string; col: Col }) {
  const ws = useWS();
  const { store, setView } = ws;
  const t = store.task(id);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);

  useEffect(() => {
    const el = ref.current as HTMLElement | null;
    el?.focus();
    if (el instanceof HTMLInputElement && el.type === "text") el.select();
  }, []);
  if (!t) return null;

  const finish = (save: boolean, moveBy?: 1 | -1) => {
    if (done.current) return;
    done.current = true;
    const v = ref.current?.value ?? "";
    setView({ editing: null });
    if (save) apply(v);
    if (moveBy) {
      const editable = COLS.filter((c) => !(store.isSummary(id) && (c === "duration" || c === "status")));
      const next = editable[editable.indexOf(col) + moveBy];
      if (next) setView({ editing: { id, col: next } });
    }
  };

  const apply = (v: string) => {
    switch (col) {
      case "title":
        if (v.trim() && v.trim() !== t.title) store.commit((s) => { const x = s.tasks.find((k) => k.id === id); if (!x) return "That task no longer exists."; x.title = v.trim(); return undefined; });
        else if (!v.trim()) ws.toast("A task needs a name.");
        return;
      case "area":
        if ((v || null) !== t.areaId) store.commit((s) => { const x = s.tasks.find((k) => k.id === id); if (!x) return "That task no longer exists."; x.areaId = v || null; return undefined; });
        return;
      case "duration": {
        const n = Number(v);
        if (n === t.duration) return;
        if (!Number.isInteger(n) || n < 0 || n > 3650) { ws.toast("Days must be a whole number from 0 to 3650."); return; }
        store.commit((s) => { const x = s.tasks.find((k) => k.id === id); if (!x) return "That task no longer exists."; x.duration = n; return undefined; });
        return;
      }
      case "due":
        if ((v || null) === t.deadline) return;
        if (v && !isDayDate(v)) { ws.toast("Choose a valid date."); return; }
        store.commit((s) => { const x = s.tasks.find((k) => k.id === id); if (!x) return "That task no longer exists."; x.deadline = v || null; return undefined; });
        return;
      case "preds":
        setPreds(store, id, v);
        return;
      case "status":
        if (v !== t.status) setStatus(store, id, v as Status);
        return;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    else if (e.key === "Tab") { e.preventDefault(); finish(true, e.shiftKey ? -1 : 1); }
  };
  const common = { ref, id: `edit-${col}`, onKeyDown, onBlur: () => finish(true), "aria-label": `Edit ${col === "preds" ? "predecessors" : col}` };

  if (col === "area")
    return (
      <select {...common} defaultValue={t.areaId ?? ""} onChange={() => finish(true)}>
        <option value="">No area</option>
        {ws.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    );
  if (col === "status")
    return (
      <select {...common} defaultValue={t.status} onChange={() => finish(true)}>
        {[...BOARD_STATUSES, "cancelled" as const].map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
      </select>
    );
  if (col === "duration") return <input {...common} type="number" min={0} max={3650} className="num" defaultValue={t.duration} />;
  if (col === "due") return <input {...common} type="date" defaultValue={t.deadline ?? ""} />;
  if (col === "preds")
    return (
      <input
        {...common}
        type="text"
        placeholder="e.g. 3.1, 4.2SS+2d"
        defaultValue={formatPredecessorCode(store.state.deps.filter((d) => d.succ === id).map((d) => ({ ref: store.wbs(d.pred), type: d.type, lagDays: d.lag })))}
      />
    );
  return <input {...common} type="text" maxLength={200} defaultValue={t.title} />;
}

/** Drag a row by its grip: top/bottom half places before/after; the middle of a group puts it inside. */
function startRowDrag(down: PointerEvent, id: string, ws: WS) {
  const { store, setView } = ws;
  const src = (down.target as HTMLElement).closest("tr");
  let g: ReturnType<typeof ghost> | null = null;
  let over: HTMLElement | null = null;
  let zone: "before" | "into" | "after" = "after";
  const clear = () => over?.classList.remove("drop-before", "drop-into", "drop-after");
  const expand = (pid: string) => setView((v) => { const c = new Set(v.collapsed); c.delete(pid); return { collapsed: c }; });

  beginPointerDrag(down, {
    onStart(e) {
      src?.classList.add("dragging");
      g = ghost(store.task(id)?.title ?? "Task");
      g.at(e);
    },
    onMove(e) {
      g?.at(e);
      const tr = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("tr[data-id]") ?? null;
      clear();
      over = tr && tr.dataset.id !== id ? tr : null;
      if (!over) return;
      const rect = over.getBoundingClientRect();
      const f = (e.clientY - rect.top) / rect.height;
      zone = store.isSummary(over.dataset.id as string) ? (f < 0.3 ? "before" : f > 0.7 ? "after" : "into") : f < 0.5 ? "before" : "after";
      over.classList.add(`drop-${zone}`);
    },
    onDrop() {
      g?.remove();
      src?.classList.remove("dragging");
      clear();
      const target = over?.dataset.id;
      if (target) dropRow(store, id, target, zone, expand);
    },
    onCancel() {
      g?.remove();
      src?.classList.remove("dragging");
      clear();
    },
  });
}
