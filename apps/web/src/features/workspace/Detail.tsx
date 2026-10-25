"use client";
import { useState } from "react";
import { CONSTRAINT_TYPES, diffDays, isDayDate, parseGBP, type ConstraintType, type DayDate } from "@23andus/domain";
import { diffSchedules } from "@23andus/scheduler";
import { useWS } from "./context";
import type { CostLine, Dep } from "./types";
import { days, describeWarning, fmtLong, linkLabel, money } from "./format";
import { newCostId } from "./ops";

const CONSTRAINT_LABEL: Record<ConstraintType, string> = {
  ASAP: "As soon as possible",
  SNET: "Start no earlier than",
  FNET: "Finish no earlier than",
  MSO: "Must start on",
  MFO: "Must finish on",
};

export function Detail() {
  const ws = useWS();
  const { store, view } = ws;
  const warnings = store.derived.result.ok ? store.derived.result.warnings : [];
  const warnHtml = (
    <section>
      <h3>Warnings</h3>
      {warnings.length ? (
        <ul className="warns">{warnings.map((w, i) => <li key={i}>{describeWarning(w, store.state, store.derived.idToWbs)}</li>)}</ul>
      ) : (
        <p className="empty">None. Everything fits its dates.</p>
      )}
    </section>
  );

  const id = view.selected;
  const t = id ? store.task(id) : undefined;
  if (!id || !t) {
    return (
      <aside className="detail" aria-label="Selected task">
        <section><h2>No task selected</h2><p className="empty">Select a task to see its links, costs, float and what moves if it slips.</p></section>
        {warnHtml}
      </aside>
    );
  }
  const s = store.sched(id);
  const summary = store.isSummary(id);
  const kv = (k: string, v: string, cls = "") => <div><dt>{k}</dt><dd className={cls}>{v}</dd></div>;
  const fl = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n < 0 ? "−" : ""}${days(n)}`);
  const linkList = (deps: Dep[], other: (d: Dep) => string) =>
    deps.length ? (
      <ul className="links">
        {deps.map((d) => (
          <li key={d.id}><span className="code">{store.wbs(other(d))}</span><span className="t">{store.task(other(d))?.title}</span><span className="lt">{linkLabel(d)}</span></li>
        ))}
      </ul>
    ) : <p className="empty">None</p>;

  const update = (fn: (x: NonNullable<ReturnType<typeof store.task>>) => string | undefined) =>
    store.commit((st) => {
      const x = st.tasks.find((k) => k.id === id);
      return x ? fn(x) : "That task no longer exists.";
    });

  return (
    <aside className="detail" aria-label="Selected task">
      <section>
        <h2><span className="ref">{store.wbs(id)}</span>{t.title}</h2>
        <dl className="kv">
          {kv("Starts", s ? fmtLong(s.start) : "—")}
          {kv("Finishes", s ? fmtLong(s.finish) : "—")}
          {kv("Latest start", s ? fmtLong(s.lateStart) : "—")}
          {kv("Latest finish", s ? fmtLong(s.lateFinish) : "—")}
          {kv("Total float", fl(s?.totalFloat), (s?.totalFloat ?? 0) < 0 ? "neg" : "")}
          {kv("Free float", fl(s?.freeFloat))}
        </dl>
      </section>

      {!summary && <Slip id={id} />}
      <Costs taskId={id} summary={summary} />

      <section>
        <h3>Comes after</h3>{linkList(store.state.deps.filter((d) => d.succ === id), (d) => d.pred)}
        <h3>Comes before</h3>{linkList(store.state.deps.filter((d) => d.pred === id), (d) => d.succ)}
      </section>

      {!summary && (
        <section>
          <h3>Due date and constraint</h3>
          <div className="form-row">
            <label htmlFor="inDue">Due<input type="date" id="inDue" value={t.deadline ?? ""} onChange={(e) => update((x) => { x.deadline = e.target.value || null; return undefined; })} /></label>
            <span className="hint">{t.deadline && s ? (s.finish > t.deadline ? `Finishes ${days(diffDays(t.deadline as DayDate, s.finish as DayDate))} late` : "On track") : "The plan is checked against it"}</span>
          </div>
          <div className="form-row">
            <label htmlFor="inCType">Constraint
              <select id="inCType" value={t.constraintType} onChange={(e) => update((x) => {
                const v = e.target.value as ConstraintType;
                x.constraintType = v;
                x.constraintDate = v === "ASAP" ? null : x.constraintDate ?? s?.start ?? store.state.project.startDate;
                return undefined;
              })}>
                {CONSTRAINT_TYPES.map((c) => <option key={c} value={c}>{CONSTRAINT_LABEL[c]}</option>)}
              </select>
            </label>
            <label htmlFor="inCDate">Date
              <input type="date" id="inCDate" value={t.constraintDate ?? ""} disabled={t.constraintType === "ASAP"} onChange={(e) => update((x) => {
                if (!isDayDate(e.target.value)) return "This constraint needs a date.";
                x.constraintDate = e.target.value;
                return undefined;
              })} />
            </label>
          </div>
        </section>
      )}
      {warnHtml}
    </aside>
  );
}

function Slip({ id }: { id: string }) {
  const { store } = useWS();
  const [state, setState] = useState<{ id: string; delta: number }>({ id, delta: 0 });
  const delta = state.id === id ? state.delta : 0;
  const t = store.task(id);
  if (!t) return null;
  let impact: React.ReactNode = <p className="empty">Change the days to see what moves before you commit.</p>;
  const base = store.derived.result;
  if (delta !== 0 && base.ok) {
    const r = store.scheduleWith({ id, duration: Math.max(0, t.duration + delta) });
    if (r.ok) {
      const changes = diffSchedules(base.tasks, r.tasks)
        .filter((c) => c.finishDelta !== 0 && !store.isSummary(c.taskId))
        .sort((a, b) => store.wbs(a.taskId).localeCompare(store.wbs(b.taskId), undefined, { numeric: true }));
      const pd = diffDays(base.projectFinish, r.projectFinish);
      const dl = store.state.project.deadline;
      const late = dl ? diffDays(dl as DayDate, r.projectFinish) : null;
      impact = (
        <>
          {changes.length ? (
            <ul className="impact">
              {changes.map((c) => (
                <li key={c.taskId}><span className="code">{store.wbs(c.taskId)}</span><span className="t">{store.task(c.taskId)?.title}</span><span className={`d ${c.finishDelta > 0 ? "later" : "earlier"}`}>{c.finishDelta > 0 ? "+" : "−"}{Math.abs(c.finishDelta)}d</span></li>
              ))}
            </ul>
          ) : <p className="empty">Nothing else moves. This task has enough float.</p>}
          <p className={`impact-sum ${late !== null && late > 0 ? "late" : ""}`}>
            {pd === 0 ? `The project still finishes ${fmtLong(r.projectFinish)}.` : `The project finishes ${days(pd)} ${pd > 0 ? "later" : "earlier"}, on ${fmtLong(r.projectFinish)}.`}
            {late !== null && late > 0 ? ` That's ${days(late)} past the deadline.` : ""}
          </p>
        </>
      );
    }
  }
  const step = (n: number) => setState({ id, delta: Math.max(-t.duration, Math.min(60, delta + n)) });
  return (
    <section>
      <h3>What if it takes longer?</h3>
      <div className="slip">
        <span className="stepper">
          <button type="button" aria-label="One day shorter" onClick={() => step(-1)}>−</button>
          <output aria-live="polite">{delta > 0 ? "+" : delta < 0 ? "−" : ""}{Math.abs(delta)}d</output>
          <button type="button" aria-label="One day longer" onClick={() => step(1)}>+</button>
        </span>
        <span className="muted">{t.duration} → {Math.max(0, t.duration + delta)} days</span>
        {delta !== 0 && (
          <button type="button" className="btn btn-primary" onClick={() => {
            if (store.commit((s) => { const x = s.tasks.find((k) => k.id === id); if (!x) return "That task no longer exists."; x.duration = Math.max(0, x.duration + delta); return undefined; }))
              setState({ id, delta: 0 });
          }}>Apply</button>
        )}
      </div>
      {impact}
    </section>
  );
}

function Costs({ taskId, summary }: { taskId: string; summary: boolean }) {
  const ws = useWS();
  const { store } = ws;
  const lines = store.state.costs.filter((c) => c.taskId === taskId);
  const below = summary
    ? store.state.costs.filter((c) => {
        for (let cur = c.taskId; cur; cur = store.task(cur)?.parentId ?? null) if (cur === taskId) return c.taskId !== taskId;
        return false;
      })
    : [];
  const sum = (xs: CostLine[], k: "estimate" | "actual") => xs.reduce((a, c) => a + (c[k] ?? 0), 0);
  const [draft, setDraft] = useState({ description: "", categoryId: ws.categories[0]?.id ?? "", estimate: "", actual: "" });

  const edit = (id: string, patch: (c: CostLine) => string | undefined) =>
    store.commit((s) => {
      const c = s.costs.find((x) => x.id === id);
      return c ? patch(c) : "That cost no longer exists.";
    });
  const moneyField = (c: CostLine, k: "estimate" | "actual") => (
    <input
      className="money-cell"
      inputMode="decimal"
      aria-label={k === "estimate" ? "Estimate" : "Actual"}
      defaultValue={c[k] === null ? "" : (c[k] / 100).toFixed(2)}
      key={`${c.id}-${k}-${c[k]}`}
      onBlur={(e) => {
        const raw = e.target.value.trim();
        const v = raw === "" ? null : parseGBP(raw);
        if (raw !== "" && v === null) { ws.toast("Enter an amount in pounds, e.g. 1,250.00."); e.target.value = c[k] === null ? "" : (c[k] / 100).toFixed(2); return; }
        if (v !== c[k]) edit(c.id, (x) => { x[k] = v; return undefined; });
      }}
    />
  );

  return (
    <section>
      <h3>Costs</h3>
      {summary && below.length > 0 && (
        <p className="muted">Its tasks: {money(sum(below, "estimate"))} estimated, {money(sum(below, "actual"))} spent.</p>
      )}
      {lines.length > 0 && (
        <table className="costs">
          <thead><tr><th>Item</th><th className="num">Estimate</th><th className="num">Actual</th><th aria-label="Remove" /></tr></thead>
          <tbody>
            {lines.map((c) => (
              <tr key={c.id}>
                <td>
                  <span className="cost-desc">{c.description}</span>
                  <span className="muted cost-cat">{ws.categories.find((k) => k.id === c.categoryId)?.name}{c.supplier ? `, ${c.supplier}` : ""}</span>
                </td>
                <td className="num">{moneyField(c, "estimate")}</td>
                <td className="num">{moneyField(c, "actual")}</td>
                <td><button className="icon-btn" aria-label={`Remove ${c.description}`} onClick={() => store.commit((s) => { s.costs = s.costs.filter((x) => x.id !== c.id); return undefined; })}>×</button></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td>Total</td><td className="num">{money(sum(lines, "estimate"), false)}</td><td className="num">{money(sum(lines, "actual"), false)}</td><td /></tr></tfoot>
        </table>
      )}
      <form
        className="cost-add"
        onSubmit={(e) => {
          e.preventDefault();
          const est = draft.estimate.trim() ? parseGBP(draft.estimate) : null;
          const act = draft.actual.trim() ? parseGBP(draft.actual) : null;
          if (!draft.description.trim()) return ws.toast("Say what the cost is for, e.g. Electrician first fix.");
          if ((draft.estimate.trim() && est === null) || (draft.actual.trim() && act === null)) return ws.toast("Enter amounts in pounds, e.g. 1,250.00.");
          const ok = store.commit((s) => {
            s.costs.push({ id: newCostId(), taskId, categoryId: draft.categoryId, description: draft.description.trim(), estimate: est, actual: act, supplier: "" });
            return undefined;
          });
          if (ok) setDraft({ ...draft, description: "", estimate: "", actual: "" });
        }}
      >
        <input aria-label="New cost item" placeholder="Add a cost, e.g. Electrician" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        <select aria-label="Category" value={draft.categoryId} onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}>
          {ws.categories.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
        <input aria-label="Estimate in pounds" inputMode="decimal" placeholder="Estimate £" value={draft.estimate} onChange={(e) => setDraft({ ...draft, estimate: e.target.value })} />
        <input aria-label="Actual in pounds" inputMode="decimal" placeholder="Actual £" value={draft.actual} onChange={(e) => setDraft({ ...draft, actual: e.target.value })} />
        <button className="btn">Add</button>
      </form>
    </section>
  );
}
