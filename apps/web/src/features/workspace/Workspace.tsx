"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { diffDays, isDayDate, parseGBP, type DayDate } from "@23andus/domain";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { WSContext, useWS, visibleRows, type Mode, type ViewState, type WS } from "./context";
import { ProjectStore } from "./store";
import type { Lookup, WState } from "./types";
import { days, fmt, money } from "./format";
import { addTask, indent, move, outdent, removeTask } from "./ops";
import { TableView } from "./TableView";
import { BoardView } from "./BoardView";
import { GanttView } from "./GanttView";
import { Detail } from "./Detail";
import { Files } from "../files/Files";

const MODES: { id: Mode; label: string }[] = [
  { id: "table", label: "Table" },
  { id: "board", label: "Board" },
  { id: "gantt", label: "Gantt" },
  { id: "photos", label: "Photos" },
  { id: "documents", label: "Plans & documents" },
];
const MODE_KEY = "23andus-view";

export function Workspace({ initial, areas, categories }: { initial: WState; areas: Lookup[]; categories: Lookup[] }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toast = useCallback((m: string) => {
    setMsg(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 4500);
  }, []);
  const [store] = useState(() => new ProjectStore(supabaseBrowser(), initial, (m) => toast(m)));
  const [view, setViewState] = useState<ViewState>({
    mode: "table",
    selected: null,
    editing: null,
    collapsed: new Set(),
    criticalOnly: false,
    areaId: "",
  });
  const setView = useCallback<WS["setView"]>(
    (patch) => setViewState((v) => ({ ...v, ...(typeof patch === "function" ? patch(v) : patch) })),
    [],
  );

  useEffect(() => {
    store.connect();
    try {
      const m = localStorage.getItem(MODE_KEY) as Mode | null;
      if (m && MODES.some((x) => x.id === m)) setView({ mode: m });
    } catch {
      /* not persisted */
    }
    return () => store.disconnect();
  }, [store, setView]);

  const ws = useMemo<WS>(() => ({ store, view, setView, toast, areas, categories }), [store, view, setView, toast, areas, categories]);

  return (
    <WSContext.Provider value={ws}>
      <Shell />
      <div className="toast" role="status" aria-live="polite" hidden={!msg}>{msg}</div>
    </WSContext.Provider>
  );
}

function Shell() {
  const ws = useWS();
  const { store, view, setView } = ws;
  const tabular = view.mode === "table" || view.mode === "board" || view.mode === "gantt";
  useKeyboard(ws);

  return (
    <div className="app">
      <TitleBlock />
      <div className="toolbar" role="toolbar" aria-label="View">
        <div className="toolbar-group">
          <span className="seg views" role="group" aria-label="View">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-pressed={view.mode === m.id}
                onClick={() => {
                  setView({ mode: m.id, editing: null });
                  try { localStorage.setItem(MODE_KEY, m.id); } catch { /* not persisted */ }
                }}
              >
                {m.label}
              </button>
            ))}
          </span>
          {tabular && (
            <>
              <label className="check"><input type="checkbox" checked={view.criticalOnly} onChange={(e) => setView({ criticalOnly: e.target.checked })} /> Critical path only</label>
              <label className="field-inline" htmlFor="fArea">Area
                <select id="fArea" value={view.areaId} onChange={(e) => setView({ areaId: e.target.value })}>
                  <option value="">All areas</option>
                  {ws.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            </>
          )}
        </div>
        <div className="toolbar-group">
          <SaveBadge />
          {tabular && (
            <>
              <button type="button" className="btn" onClick={() => {
                const id = addTask(store, view.selected);
                if (id) setView({ selected: id, editing: view.mode === "table" ? { id, col: "title" } : null });
              }}>Add task</button>
              <button type="button" className="btn" disabled={!store.canUndo} onClick={() => store.undo()}>Undo</button>
            </>
          )}
        </div>
      </div>

      {!store.derived.result.ok && (
        <div className="banner" role="alert"><strong>The plan can't be scheduled.</strong></div>
      )}

      {tabular ? (
        <main className="work">
          <section className="sheet" aria-label="Tasks">
            {store.state.tasks.length === 0 ? <EmptyPlan /> : view.mode === "table" ? <TableView /> : view.mode === "board" ? <BoardView /> : <GanttView />}
            {view.mode === "table" && store.state.tasks.length > 0 && <Keys />}
          </section>
          <Detail />
        </main>
      ) : (
        <Files kind={view.mode === "photos" ? "photos" : "documents"} />
      )}
    </div>
  );
}

function EmptyPlan() {
  const { store, setView } = useWS();
  return (
    <div className="empty-state panel">
      <h2>No tasks yet</h2>
      <p>Add the first task, then keep going with <kbd>⇧</kbd><kbd>Enter</kbd>. Indent with <kbd>Tab</kbd> to group tasks into phases.</p>
      <button className="btn btn-primary" onClick={() => {
        const id = addTask(store, null);
        if (id) setView({ mode: "table", selected: id, editing: { id, col: "title" } });
      }}>Add the first task</button>
    </div>
  );
}

function SaveBadge() {
  const { store } = useWS();
  const label = store.saveState === "saving" ? "Saving…" : store.saveState === "error" ? "Not saved" : "Saved";
  return <span className={`save-badge ${store.saveState}`} aria-live="polite">{label}</span>;
}

function TitleBlock() {
  const { store, toast } = useWS();
  const p = store.state.project;
  const r = store.derived.result;
  const fin = r.ok ? r.projectFinish : null;
  const leaves = store.state.tasks.filter((t) => !store.isSummary(t.id) && t.status !== "cancelled");
  const crit = r.ok ? leaves.filter((t) => r.tasks.get(t.id)?.isCritical).length : 0;
  const est = store.state.costs.reduce((a, c) => a + (c.estimate ?? 0), 0);
  const act = store.state.costs.reduce((a, c) => a + (c.actual ?? 0), 0);
  const [budgetText, setBudgetText] = useState<string | null>(null);

  let margin: React.ReactNode = <dd>—</dd>;
  if (fin && p.deadline) {
    const m = diffDays(fin as DayDate, p.deadline as DayDate);
    margin = m >= 0 ? <dd className="ok">{days(m)} spare</dd> : <dd className="late">{days(m)} late</dd>;
  }
  const remaining = p.budget === null ? null : p.budget - act;

  const setDate = (field: "startDate" | "deadline", v: string) =>
    store.commit((s) => {
      if (field === "startDate" && !isDayDate(v)) return "The project needs a start date.";
      if (field === "deadline" && v && v < s.project.startDate) return "The deadline can't be before the start.";
      s.project[field] = (v || null) as string;
      return undefined;
    });

  return (
    <header className="block" aria-label="Project">
      <div className="block-photo">
        <img src="/house-front.jpg" alt="Number 23 from the front path" width={540} height={386} />
        <span className="logo">23 <span className="amp">&amp;</span> Us</span>
      </div>
      <div className="block-title">
        <span className="field-label">Project</span>
        <h1>
          <input
            className="title-input"
            aria-label="Project name"
            defaultValue={p.name}
            key={p.name}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== p.name) store.commit((s) => { s.project.name = v; return undefined; });
              else e.target.value = p.name;
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </h1>
      </div>
      <dl className="block-fields wide">
        <div><dt><label htmlFor="inStart">Start</label></dt><dd><input type="date" id="inStart" value={p.startDate} onChange={(e) => setDate("startDate", e.target.value)} /></dd></div>
        <div><dt>Finish</dt><dd>{fin ? fmt(fin) : "—"}</dd></div>
        <div><dt><label htmlFor="inDeadline">Deadline</label></dt><dd><input type="date" id="inDeadline" value={p.deadline ?? ""} onChange={(e) => setDate("deadline", e.target.value)} /></dd></div>
        <div><dt>Margin</dt>{margin}</div>
        <div>
          <dt><label htmlFor="inBudget">Budget</label></dt>
          <dd>
            <input
              id="inBudget"
              className="money-input"
              inputMode="decimal"
              value={budgetText ?? (p.budget === null ? "" : money(p.budget))}
              placeholder="Set budget"
              onFocus={() => setBudgetText(p.budget === null ? "" : (p.budget / 100).toFixed(0))}
              onChange={(e) => setBudgetText(e.target.value)}
              onBlur={() => {
                const t = (budgetText ?? "").trim();
                setBudgetText(null);
                const v = t === "" ? null : parseGBP(t);
                if (t !== "" && v === null) return toast("Enter the budget in pounds, e.g. 18,500.");
                if (v !== p.budget) store.commit((s) => { s.project.budget = v; return undefined; });
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          </dd>
        </div>
        <div><dt>Estimated</dt><dd className={p.budget !== null && est > p.budget ? "late" : ""}>{money(est)}</dd></div>
        <div><dt>Spent</dt><dd>{money(act)}</dd></div>
        <div><dt>Remaining</dt><dd className={remaining !== null && remaining < 0 ? "late" : remaining !== null ? "ok" : ""}>{remaining === null ? "—" : money(remaining)}</dd></div>
        <div><dt>Critical</dt><dd>{crit} of {leaves.length} tasks</dd></div>
        <div><dt>As of</dt><dd>Today</dd></div>
      </dl>
    </header>
  );
}

function Keys() {
  return (
    <p className="keys" aria-label="Keyboard shortcuts">
      <span><kbd>↑</kbd><kbd>↓</kbd> select</span>
      <span><kbd>Enter</kbd> edit</span>
      <span><kbd>Tab</kbd> indent</span>
      <span><kbd>⇧</kbd><kbd>Tab</kbd> outdent</span>
      <span><kbd>Alt</kbd><kbd>↑</kbd><kbd>↓</kbd> move</span>
      <span><kbd>⇧</kbd><kbd>Enter</kbd> new task</span>
      <span><kbd>⌫</kbd> delete</span>
      <span><kbd>⌘</kbd><kbd>Z</kbd> undo</span>
    </p>
  );
}

function useKeyboard(ws: WS) {
  const ref = useRef(ws);
  ref.current = ws;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { store, view, setView } = ref.current;
      const target = e.target as HTMLElement;
      if (target.closest(".cell-edit")) return; // editors handle their own keys
      if (view.mode === "photos" || view.mode === "documents") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        if (target.matches("input, select, textarea")) return;
        e.preventDefault();
        store.undo();
        return;
      }
      if (target.matches("input, select, textarea, button, [contenteditable]")) return;
      const rows = visibleRows(ref.current);
      const i = rows.findIndex((r) => r.node.id === view.selected);
      const id = view.selected;
      const expand = (pid: string) => setView((v) => { const c = new Set(v.collapsed); c.delete(pid); return { collapsed: c }; });
      switch (e.key) {
        case "ArrowDown":
        case "ArrowUp": {
          e.preventDefault();
          const dir = e.key === "ArrowDown" ? 1 : -1;
          if (e.altKey && id) { move(store, id, dir); return; }
          const next = rows[i < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, i + dir))];
          if (next) {
            setView({ selected: next.node.id });
            requestAnimationFrame(() => document.querySelector(`[data-id="${next.node.id}"]`)?.scrollIntoView({ block: "nearest" }));
          }
          return;
        }
        case "ArrowLeft":
        case "ArrowRight":
          if (id && store.isSummary(id)) {
            e.preventDefault();
            setView((v) => { const c = new Set(v.collapsed); if (e.key === "ArrowLeft") c.add(id); else c.delete(id); return { collapsed: c }; });
          }
          return;
        case "Enter":
          e.preventDefault();
          if (e.shiftKey) {
            const nid = addTask(store, id);
            if (nid) setView({ selected: nid, editing: view.mode === "table" ? { id: nid, col: "title" } : null });
          } else if (id && view.mode === "table") setView({ editing: { id, col: "title" } });
          return;
        case "Tab":
          if (!id || view.mode !== "table") return;
          e.preventDefault();
          if (e.shiftKey) outdent(store, id);
          else indent(store, id, expand);
          return;
        case "Backspace":
        case "Delete":
          if (id) {
            e.preventDefault();
            const name = store.task(id)?.title ?? "task";
            if (removeTask(store, id)) {
              setView({ selected: rows[Math.max(0, i - 1)]?.node.id ?? null });
              ref.current.toast(`Deleted ${name}. Undo brings it back.`);
            }
          }
          return;
        case "Escape":
          setView({ selected: null });
          return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
