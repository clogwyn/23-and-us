"use client";
/**
 * Project store: the single source of truth for one project on screen.
 *
 *   commit(mutator) → engine validates → screen updates at once → save diff in background
 *                                         → persist computed schedule (debounced)
 *   realtime event from another member   → reload when no save is in flight
 *
 * A failed save shows the reason and reloads from the database, so the screen
 * never drifts from what is actually stored.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { todayIn, wbsMaps, type DayDate } from "@23andus/domain";
import { schedule, type ScheduleInput, type ScheduleResult } from "@23andus/scheduler";
import { load, save } from "./mapping";
import type { WState } from "./types";
import { describeErrors } from "./format";

export type SaveState = "saved" | "saving" | "error";

export interface Derived {
  result: ScheduleResult;
  idToWbs: Map<string, string>;
  wbsToId: Map<string, string>;
  hasKids: Set<string>;
  statusDate: string;
}

export function toInput(s: WState, statusDate: string, override?: { id: string; duration: number }): ScheduleInput {
  const live = s.tasks.filter((t) => t.status !== "cancelled");
  const ids = new Set(live.map((t) => t.id));
  return {
    projectStart: s.project.startDate as DayDate,
    projectDeadline: (s.project.deadline as DayDate | null) ?? null,
    statusDate: statusDate as DayDate,
    tasks: live.map((t) => ({
      id: t.id,
      parentId: t.parentId && ids.has(t.parentId) ? t.parentId : null,
      durationDays: override?.id === t.id ? override.duration : t.duration,
      constraintType: t.constraintType,
      constraintDate: t.constraintDate as DayDate | null,
      deadline: t.deadline as DayDate | null,
      actualStart: t.actualStart as DayDate | null,
      actualFinish: t.actualFinish as DayDate | null,
    })),
    dependencies: s.deps
      .filter((d) => ids.has(d.pred) && ids.has(d.succ))
      .map((d) => ({ predecessorId: d.pred, successorId: d.succ, type: d.type, lagDays: d.lag })),
  };
}

function derive(s: WState): Derived {
  const statusDate = todayIn("Europe/London");
  const nodes = s.tasks.map((t) => ({ id: t.id, parentId: t.parentId, sort: t.sort }));
  const { idToWbs, wbsToId } = wbsMaps(nodes);
  const hasKids = new Set(s.tasks.filter((t) => t.parentId).map((t) => t.parentId as string));
  return { result: schedule(toInput(s, statusDate)), idToWbs, wbsToId, hasKids, statusDate };
}

type Listener = () => void;

export class ProjectStore {
  state: WState;
  derived: Derived;
  saveState: SaveState = "saved";
  lastError: string | null = null;
  private history: WState[] = [];
  private listeners = new Set<Listener>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private applyTimer: ReturnType<typeof setTimeout> | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | null = null;
  private version = 0;

  constructor(
    private sb: SupabaseClient,
    initial: WState,
    private onMessage: (msg: string) => void,
  ) {
    this.state = initial;
    this.derived = derive(initial);
  }

  // React subscription (useSyncExternalStore)
  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  get canUndo() {
    return this.history.length > 0;
  }

  /** Validate, show, save. The mutator may return a string to refuse with that message. */
  commit(mutate: (draft: WState) => unknown, opts: { silent?: boolean } = {}): boolean {
    const next = structuredClone(this.state);
    const refusal = mutate(next);
    if (typeof refusal === "string") {
      this.onMessage(refusal);
      return false;
    }
    const d = derive(next);
    if (!d.result.ok) {
      this.onMessage(describeErrors(d.result.errors, next, d.idToWbs));
      return false;
    }
    if (!opts.silent) {
      this.history.push(this.state);
      if (this.history.length > 60) this.history.shift();
    }
    const prev = this.state;
    this.state = next;
    this.derived = d;
    this.emit();
    this.enqueueSave(prev, next);
    return true;
  }

  undo() {
    const prev = this.history.pop();
    if (!prev) return;
    const cur = this.state;
    this.state = prev;
    this.derived = derive(prev);
    this.emit();
    this.enqueueSave(cur, prev);
    this.onMessage("Undone");
  }

  private enqueueSave(prev: WState, next: WState) {
    this.pending++;
    this.setSave("saving");
    this.queue = this.queue
      .then(() => save(this.sb, prev, next))
      .then(() => {
        this.pending--;
        if (this.pending === 0) {
          this.setSave("saved");
          this.scheduleApply();
        }
      })
      .catch(async (e: unknown) => {
        this.pending = 0;
        this.lastError = e instanceof Error ? e.message : String(e);
        this.setSave("error");
        this.onMessage(`Couldn't save: ${this.lastError}. Showing what's stored instead.`);
        this.queue = Promise.resolve();
        await this.reload();
      });
  }

  private setSave(s: SaveState) {
    if (this.saveState !== s) {
      this.saveState = s;
      this.emit();
    }
  }

  /** Store the computed schedule so other tools (and the projects list) can read it. */
  private scheduleApply() {
    clearTimeout(this.applyTimer);
    this.applyTimer = setTimeout(() => void this.applySchedule(), 1200);
  }

  private async applySchedule(retry = true) {
    if (this.pending > 0 || !this.derived.result.ok) return;
    const { data, error } = await this.sb.from("projects").select("schedule_version").eq("id", this.state.project.id).single();
    if (error || !data) return;
    const rows = [...this.derived.result.tasks.entries()].map(([id, t]) => ({
      id,
      early_start: t.start,
      early_finish: t.finish,
      late_start: t.lateStart,
      late_finish: t.lateFinish,
      total_float: t.totalFloat,
      free_float: t.freeFloat,
      is_critical: t.isCritical,
      is_summary: t.isSummary,
    }));
    const { data: ok } = await this.sb.rpc("apply_schedule", { p_project: this.state.project.id, p_version: data.schedule_version, p_rows: rows });
    if (ok === false && retry) {
      await this.reload();
      await this.applySchedule(false);
    }
  }

  async reload() {
    try {
      const fresh = await load(this.sb, this.state.project.id);
      if (JSON.stringify(fresh) === JSON.stringify(this.state)) return;
      this.state = fresh;
      this.derived = derive(fresh);
      this.history = [];
      this.emit();
    } catch (e) {
      this.onMessage(`Couldn't refresh: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private requestReload() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      if (this.pending > 0) return this.requestReload();
      void this.reload();
    }, 500);
  }

  /** Live updates from other household members. RLS limits events to this household. */
  connect() {
    const id = this.state.project.id;
    const ch = this.sb.channel(`project:${id}`);
    for (const table of ["tasks", "task_dependencies", "cost_lines"]) {
      ch.on("postgres_changes", { event: "*", schema: "public", table, filter: `project_id=eq.${id}` }, () => this.requestReload());
    }
    ch.on("postgres_changes", { event: "UPDATE", schema: "public", table: "projects", filter: `id=eq.${id}` }, () => this.requestReload());
    ch.subscribe();
    this.unsubscribe = () => void this.sb.removeChannel(ch);
    const onFocus = () => this.requestReload();
    window.addEventListener("focus", onFocus);
    const prev = this.unsubscribe;
    this.unsubscribe = () => {
      prev();
      window.removeEventListener("focus", onFocus);
    };
  }

  disconnect() {
    this.unsubscribe?.();
    clearTimeout(this.applyTimer);
    clearTimeout(this.reloadTimer);
  }

  // Convenience lookups for views
  wbs = (id: string) => this.derived.idToWbs.get(id) ?? "?";
  sched = (id: string) => (this.derived.result.ok ? this.derived.result.tasks.get(id) : undefined);
  task = (id: string) => this.state.tasks.find((t) => t.id === id);
  isSummary = (id: string) => this.derived.hasKids.has(id);
  scheduleOf = (s: WState) => schedule(toInput(s, this.derived.statusDate));
  scheduleWith = (override: { id: string; duration: number }) => schedule(toInput(this.state, this.derived.statusDate, override));
  wbsOf = (s: WState) => wbsMaps(s.tasks.map((t) => ({ id: t.id, parentId: t.parentId, sort: t.sort }))).idToWbs;
}
