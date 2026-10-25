/**
 * Kanban board: one column per status, cards are leaf tasks in start-date order.
 * Groups appear as a small label on each card, so the tree survives on the board.
 * Drag a card to another column to change its status.
 */
import type { ViewCtx } from "./ctx.ts";
import type { PStatus } from "./model.ts";
import { beginPointerDrag, consumeDragClick, ghost } from "./drag.ts";

const COLUMNS: PStatus[] = ["todo", "in_progress", "blocked", "done"];

export function renderBoard(host: HTMLElement, ctx: ViewCtx): void {
  const visible = new Set(ctx.rows().map((r) => r.node.id));
  const leaves = ctx.state().tasks.filter((t) => visible.has(t.id) && !ctx.isSummary(t.id));
  const byStart = (a: string, b: string) => (ctx.sched(a)?.start ?? "").localeCompare(ctx.sched(b)?.start ?? "") || ctx.wbs(a).localeCompare(ctx.wbs(b), undefined, { numeric: true });

  host.innerHTML = `<div class="board">${COLUMNS.map((col) => {
    const cards = leaves.filter((t) => t.status === col).map((t) => t.id).sort(byStart);
    return `<section class="lane" data-lane="${col}" aria-label="${ctx.statusLabel[col]}">
      <header class="lane-head"><span class="pill ${col}">${ctx.statusLabel[col]}</span><span class="lane-count">${cards.length}</span></header>
      <div class="lane-cards">${cards.map((id) => card(id, ctx)).join("") || `<p class="lane-empty">Drop a task here</p>`}</div>
    </section>`;
  }).join("")}</div>`;
}

function card(id: string, ctx: ViewCtx): string {
  const t = ctx.byId(id);
  const s = ctx.sched(id);
  if (!t) return "";
  const group = t.parentId ? ctx.byId(t.parentId)?.title : null;
  const f = s?.totalFloat;
  const floatTxt = f === null || f === undefined ? "" : f < 0 ? `${-f}d late` : f === 0 ? "No float" : `${f}d float`;
  const when = s ? (t.duration === 0 ? ctx.fmt(s.start) : `${ctx.fmt(s.start)} – ${ctx.fmt(s.finish)}`) : "";
  return `<article class="card ${s?.isCritical ? "critical" : ""} ${ctx.selected() === id ? "selected" : ""}" data-card="${id}" tabindex="0" aria-label="${ctx.esc(t.title)}">
    <div class="card-top"><span class="card-wbs">${ctx.wbs(id)}</span>${group ? `<span class="card-group">${ctx.esc(group)}</span>` : ""}</div>
    <p class="card-title">${t.duration === 0 ? `<span class="diamond" aria-label="Milestone"></span>` : ""}${ctx.esc(t.title)}</p>
    <div class="card-meta"><span>${when}</span><span class="card-float ${f !== undefined && f !== null && f < 0 ? "neg" : ""}">${floatTxt}</span></div>
    <div class="card-meta"><span class="muted">${ctx.esc(t.area)}</span><span class="muted">${t.duration ? `${t.duration}d` : "Milestone"}</span></div>
  </article>`;
}

export function wireBoard(host: HTMLElement, ctx: ViewCtx, rerender: () => void): void {
  host.addEventListener("click", (e) => {
    if (consumeDragClick()) return;
    const c = (e.target as HTMLElement).closest<HTMLElement>("[data-card]");
    if (c) { ctx.select(c.dataset.card ?? null); rerender(); }
  });

  host.addEventListener("pointerdown", (down) => {
    const cardEl = (down.target as HTMLElement).closest<HTMLElement>("[data-card]");
    if (!cardEl || !host.querySelector(".board")) return;
    const id = cardEl.dataset.card as string;
    let g: ReturnType<typeof ghost> | null = null;
    let target: HTMLElement | null = null;

    beginPointerDrag(down, {
      onStart(e) {
        cardEl.classList.add("dragging");
        g = ghost(ctx.byId(id)?.title ?? "Task");
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
        const status = target?.dataset.lane as PStatus | undefined;
        const task = ctx.byId(id);
        if (!status || !task || task.status === status) return;
        const ok = ctx.commit((s) => {
          const t = s.tasks.find((x) => x.id === id);
          if (t) return ctx.setStatus(t, status);
          return "That task no longer exists.";
        });
        if (ok) ctx.toast(`${task.title} moved to ${ctx.statusLabel[status]}.`);
      },
      onCancel() {
        g?.remove();
        cardEl.classList.remove("dragging");
        target?.classList.remove("drop-target");
      },
    });
  });
}
