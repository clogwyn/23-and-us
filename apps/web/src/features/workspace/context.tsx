"use client";
import { createContext, useContext, useSyncExternalStore } from "react";
import { flattenTree, type FlatRow } from "@23andus/domain";
import type { ProjectStore } from "./store";
import type { Lookup } from "./types";

export type Mode = "table" | "board" | "gantt" | "photos" | "documents";

export interface ViewState {
  mode: Mode;
  selected: string | null;
  editing: { id: string; col: string } | null;
  collapsed: Set<string>;
  criticalOnly: boolean;
  areaId: string;
}

export interface WS {
  store: ProjectStore;
  view: ViewState;
  setView: (patch: Partial<ViewState> | ((v: ViewState) => Partial<ViewState>)) => void;
  toast: (msg: string) => void;
  areas: Lookup[];
  categories: Lookup[];
}

export const WSContext = createContext<WS | null>(null);

/** Workspace context, re-rendering whenever the project store changes. */
export function useWS(): WS {
  const ws = useContext(WSContext);
  if (!ws) throw new Error("useWS outside Workspace");
  useSyncExternalStore(ws.store.subscribe, ws.store.getVersion, ws.store.getVersion);
  return ws;
}

type Row = FlatRow<{ id: string; parentId: string | null; sort: number }>;

/** Rows in display order after collapse and filters. A matching task keeps its groups visible. */
export function visibleRows(ws: Pick<WS, "store" | "view">): Row[] {
  const { store, view } = ws;
  const flat = flattenTree(store.state.tasks.map((t) => ({ id: t.id, parentId: t.parentId, sort: t.sort })));
  let keep: Set<string> | null = null;
  if (view.criticalOnly || view.areaId) {
    keep = new Set();
    for (const t of store.state.tasks) {
      if (store.isSummary(t.id)) continue;
      const okCrit = !view.criticalOnly || store.sched(t.id)?.isCritical;
      const okArea = !view.areaId || t.areaId === view.areaId;
      if (!okCrit || !okArea) continue;
      for (let cur: string | null = t.id; cur; cur = store.task(cur)?.parentId ?? null) keep.add(cur);
    }
  }
  const out: Row[] = [];
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
