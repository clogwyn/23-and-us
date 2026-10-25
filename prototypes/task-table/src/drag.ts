/**
 * Pointer-based dragging that works the same with mouse, pen and touch
 * (HTML5 drag-and-drop doesn't work on phones). A drag starts only after the
 * pointer moves a few pixels, so plain clicks and taps still behave as clicks.
 */
export interface DragHandlers {
  onStart?(e: PointerEvent): void;
  onMove(e: PointerEvent, dx: number, dy: number): void;
  onDrop(e: PointerEvent, dx: number, dy: number): void;
  onCancel?(): void;
}

let suppressNextClick = false;

/** Call at the top of click handlers: true if this click is the tail of a drag. */
export function consumeDragClick(): boolean {
  if (!suppressNextClick) return false;
  suppressNextClick = false;
  return true;
}

export function beginPointerDrag(down: PointerEvent, h: DragHandlers, threshold = 4): void {
  if (down.button !== 0) return;
  const x0 = down.clientX;
  const y0 = down.clientY;
  let dragging = false;

  const move = (e: PointerEvent) => {
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (!dragging) {
      if (Math.hypot(dx, dy) < threshold) return;
      dragging = true;
      document.body.classList.add("is-dragging");
      h.onStart?.(e);
    }
    e.preventDefault();
    h.onMove(e, dx, dy);
  };
  const end = (e: PointerEvent, cancelled: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    document.body.classList.remove("is-dragging");
    if (!dragging) return;
    suppressNextClick = true;
    setTimeout(() => { suppressNextClick = false; }, 0);
    if (cancelled) h.onCancel?.();
    else h.onDrop(e, e.clientX - x0, e.clientY - y0);
  };
  const up = (e: PointerEvent) => end(e, false);
  const cancel = (e: PointerEvent) => end(e, true);
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape" && dragging) {
      e.stopPropagation();
      end(new PointerEvent("pointercancel"), true);
    }
  };

  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}

/** A floating label that follows the pointer during a drag. */
export function ghost(text: string): { el: HTMLElement; at(e: PointerEvent): void; remove(): void } {
  const el = document.createElement("div");
  el.className = "drag-ghost";
  el.textContent = text;
  document.body.append(el);
  return {
    el,
    at(e) { el.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`; },
    remove() { el.remove(); },
  };
}
