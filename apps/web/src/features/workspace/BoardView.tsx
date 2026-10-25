"use client";
import { useWS, visibleRows } from "./context";
import { BOARD_STATUSES, STATUS_LABEL, type Status } from "./types";
import { fmt, money } from "./format";
import { setStatus } from "./ops";
import { beginPointerDrag, consumeDragClick, ghost } from "./drag";

/** Kanban: a lane per status; cards are tasks (not groups), in start-date order. Drag a card to change its status. */
export function BoardView() {
  const ws = useWS();
  const { store, view, setView } = ws;
  const visible = new Set(visibleRows(ws).map((r) => r.node.id));
  const leaves = store.state.tasks.filter((t) => visible.has(t.id) && !store.isSummary(t.id));
  const byStart = (a: string, b: string) =>
    (store.sched(a)?.start ?? "").localeCompare(store.sched(b)?.start ?? "") || store.wbs(a).localeCompare(store.wbs(b), undefined, { numeric: true });
  const costOf = (id: string) => store.state.costs.filter((c) => c.taskId === id).reduce((a, c) => a + (c.estimate ?? 0), 0);

  const onPointerDown = (down: React.PointerEvent, id: string) => {
    const cardEl = down.currentTarget as HTMLElement;
    let g: ReturnType<typeof ghost> | null = null;
    let target: HTMLElement | null = null;
    beginPointerDrag(down.nativeEvent, {
      onStart(e) {
        cardEl.classList.add("dragging");
        g = ghost(store.task(id)?.title ?? "Task");
        g.at(e);
      },
      onMove(e) {
        g?.at(e);
        const lane = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-lane]") ?? null;
        if (lane !== target) {
          target?.classList.remove("drop-target");
          target = lane;
          target?.classList.add("drop-target");
        }
      },
      onDrop() {
        g?.remove();
        cardEl.classList.remove("dragging");
        target?.classList.remove("drop-target");
        const status = target?.dataset.lane as Status | undefined;
        const task = store.task(id);
        if (!status || !task || task.status === status) return;
        if (setStatus(store, id, status)) ws.toast(`${task.title} moved to ${STATUS_LABEL[status]}.`);
      },
      onCancel() {
        g?.remove();
        cardEl.classList.remove("dragging");
        target?.classList.remove("drop-target");
      },
    });
  };

  return (
    <div className="board">
      {BOARD_STATUSES.map((col) => {
        const cards = leaves.filter((t) => t.status === col).map((t) => t.id).sort(byStart);
        return (
          <section key={col} className="lane" data-lane={col} aria-label={STATUS_LABEL[col]}>
            <header className="lane-head"><span className={`pill ${col}`}>{STATUS_LABEL[col]}</span><span className="lane-count">{cards.length}</span></header>
            <div className="lane-cards">
              {cards.length === 0 && <p className="lane-empty">Drop a task here</p>}
              {cards.map((id) => {
                const t = store.task(id);
                const s = store.sched(id);
                if (!t) return null;
                const group = t.parentId ? store.task(t.parentId)?.title : null;
                const f = s?.totalFloat;
                const floatTxt = f === null || f === undefined ? "" : f < 0 ? `${-f}d late` : f === 0 ? "No float" : `${f}d float`;
                const est = costOf(id);
                return (
                  <article
                    key={id}
                    data-card={id}
                    tabIndex={0}
                    aria-label={t.title}
                    className={`card ${s?.isCritical ? "critical" : ""} ${view.selected === id ? "selected" : ""}`}
                    onPointerDown={(e) => onPointerDown(e, id)}
                    onClick={() => { if (!consumeDragClick()) setView({ selected: id }); }}
                    onKeyDown={(e) => { if (e.key === " ") { e.preventDefault(); setView({ selected: id }); } }}
                  >
                    <div className="card-top"><span className="card-wbs">{store.wbs(id)}</span>{group && <span className="card-group">{group}</span>}</div>
                    <p className="card-title">{t.duration === 0 && <span className="diamond" aria-label="Milestone" />}{t.title}</p>
                    <div className="card-meta">
                      <span>{s ? (t.duration === 0 ? fmt(s.start) : `${fmt(s.start)} – ${fmt(s.finish)}`) : ""}</span>
                      <span className={`card-float ${f !== undefined && f !== null && f < 0 ? "neg" : ""}`}>{floatTxt}</span>
                    </div>
                    <div className="card-meta">
                      <span className="muted">{ws.areas.find((a) => a.id === t.areaId)?.name ?? ""}</span>
                      <span className="muted">{est ? money(est) : t.duration ? `${t.duration}d` : "Milestone"}</span>
                    </div>
                    {t.deadline && <div className="card-meta"><span className={s && s.finish > t.deadline ? "due-late" : "muted"}>Due {fmt(t.deadline)}</span></div>}
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
