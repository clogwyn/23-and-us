/**
 * Integration tests against a real local Supabase stack (started by the CLI in CI).
 * Covers the save/load path the app uses, the security rules between households,
 * invites, the schedule write-back, and private storage.
 *
 * Needs: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (from `supabase status -o env`).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { schedule } from "@23andus/scheduler";
import { load, save } from "../src/features/workspace/mapping";
import type { Task, WState } from "../src/features/workspace/types";

const URL = process.env.SUPABASE_URL ?? process.env.API_URL ?? "";
const ANON = process.env.SUPABASE_ANON_KEY ?? process.env.ANON_KEY ?? process.env.PUBLISHABLE_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY ?? process.env.SECRET_KEY ?? "";
const run = URL && ANON && SERVICE ? describe : describe.skip;

const stamp = Date.now();
const users = { alice: `alice+${stamp}@example.com`, bob: `bob+${stamp}@example.com` };
const PASSWORD = "Correct-Horse-Battery-9";

async function signedIn(email: string): Promise<SupabaseClient> {
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return c;
}

const task = (id: string, title: string, extra: Partial<Task> = {}): Task => ({
  id, parentId: null, sort: 1024, title, description: "", areaId: null, duration: 1, status: "todo",
  constraintType: "ASAP", constraintDate: null, deadline: null, actualStart: null, actualFinish: null, ...extra,
});
const ids = () => crypto.randomUUID();
const norm = (s: WState) => ({
  project: s.project,
  tasks: [...s.tasks].sort((a, b) => a.id.localeCompare(b.id)),
  deps: [...s.deps].sort((a, b) => a.id.localeCompare(b.id)),
  costs: [...s.costs].sort((a, b) => a.id.localeCompare(b.id)),
});

run("against a local Supabase", () => {
  let alice: SupabaseClient;
  let bob: SupabaseClient;
  let householdA: string;
  let projectId: string;
  let state: WState;
  let labour: string;

  beforeAll(async () => {
    const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
    for (const email of Object.values(users)) {
      const { error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
      if (error) throw error;
    }
    alice = await signedIn(users.alice);
    bob = await signedIn(users.bob);
  });

  it("onboards a household with rooms and categories, idempotently", async () => {
    const { data: h, error } = await alice.rpc("create_household", { p_name: "23 & Us" });
    expect(error).toBeNull();
    householdA = h as string;
    const again = await alice.rpc("create_household", { p_name: "Again" });
    expect(again.data).toBe(householdA);
    const areas = await alice.from("areas").select("id").eq("household_id", householdA);
    expect(areas.data).toHaveLength(9);
    const cats = await alice.from("cost_categories").select("id, name").eq("household_id", householdA);
    labour = (cats.data ?? []).find((c) => c.name === "Labour")?.id as string;
    expect(labour).toBeTruthy();
    await bob.rpc("create_household", { p_name: "Bob's" });
  });

  it("saves and reloads a whole plan exactly", async () => {
    const p = await alice.from("projects").insert({ household_id: householdA, name: "Kitchen", start_date: "2026-11-02", budget_pence: 1_850_000 }).select("id").single();
    expect(p.error).toBeNull();
    projectId = p.data?.id as string;
    const empty = await load(alice, projectId);

    const [g, a, b, c] = [ids(), ids(), ids(), ids()];
    const next: WState = structuredClone(empty);
    next.tasks = [
      task(g, "First fix"),
      task(a, "Electrics", { parentId: g, duration: 3, sort: 1024 }),
      task(b, "Plumbing", { parentId: g, duration: 2, sort: 2048 }),
      task(c, "Plaster", { duration: 4, sort: 2048, deadline: "2026-11-30" }),
    ];
    next.deps = [
      { id: ids(), pred: a, succ: b, type: "SS", lag: 1 },
      { id: ids(), pred: g, succ: c, type: "FS", lag: 0 },
    ];
    next.costs = [{ id: ids(), taskId: a, categoryId: labour, description: "Electrician", estimate: 120_000, actual: null, supplier: "" }];
    await save(alice, empty, next);
    state = await load(alice, projectId);
    expect(norm(state)).toEqual(norm(next));
  });

  it("handles reordering, reparenting, reversing a link and deleting a group", async () => {
    const [g, a, b, c] = ["First fix", "Electrics", "Plumbing", "Plaster"].map((t) => state.tasks.find((x) => x.title === t)?.id as string) as [string, string, string, string];
    const next = structuredClone(state);
    const tb = next.tasks.find((t) => t.id === b) as Task;
    tb.parentId = null; // out of the group
    tb.sort = 3072;
    next.deps = next.deps.filter((d) => !(d.pred === a && d.succ === b));
    next.deps.push({ id: ids(), pred: b, succ: a, type: "FS", lag: 2 }); // reversed direction
    const ta = next.tasks.find((t) => t.id === a) as Task;
    ta.status = "in_progress";
    ta.actualStart = "2026-11-02";
    await save(alice, state, next);
    state = await load(alice, projectId);
    expect(norm(state)).toEqual(norm(next));

    // Delete the group: its child, links and the child's costs go with it.
    const del = structuredClone(state);
    del.tasks = del.tasks.filter((t) => t.id !== g && t.id !== a);
    del.deps = del.deps.filter((d) => ![g, a].includes(d.pred) && ![g, a].includes(d.succ));
    del.costs = del.costs.filter((x) => x.taskId !== a);
    await save(alice, state, del);
    state = await load(alice, projectId);
    expect(state.tasks.map((t) => t.title).sort()).toEqual(["Plaster", "Plumbing"]);
    expect(state.deps).toHaveLength(0);
    expect(state.costs).toHaveLength(0);
    expect(c).toBeTruthy();
  });

  it("refuses a dependency loop at the database too", async () => {
    const [p1, p2] = state.tasks.map((t) => t.id) as [string, string];
    const ins1 = await alice.from("task_dependencies").insert({ household_id: householdA, project_id: projectId, predecessor_id: p1, successor_id: p2 });
    expect(ins1.error).toBeNull();
    const ins2 = await alice.from("task_dependencies").insert({ household_id: householdA, project_id: projectId, predecessor_id: p2, successor_id: p1 });
    expect(ins2.error?.message).toMatch(/loop/);
    state = await load(alice, projectId);
  });

  it("writes the computed schedule back, refusing stale versions", async () => {
    const r = schedule({
      projectStart: "2026-11-02" as never,
      tasks: state.tasks.map((t) => ({ id: t.id, parentId: t.parentId, durationDays: t.duration })),
      dependencies: state.deps.map((d) => ({ predecessorId: d.pred, successorId: d.succ, type: d.type, lagDays: d.lag })),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = [...r.tasks].map(([id, s]) => ({ id, early_start: s.start, early_finish: s.finish, late_start: s.lateStart, late_finish: s.lateFinish, total_float: s.totalFloat, free_float: s.freeFloat, is_critical: s.isCritical, is_summary: s.isSummary }));
    const { data: v } = await alice.from("projects").select("schedule_version").eq("id", projectId).single();
    const ok = await alice.rpc("apply_schedule", { p_project: projectId, p_version: v?.schedule_version, p_rows: rows });
    expect(ok.data).toBe(true);
    const stale = await alice.rpc("apply_schedule", { p_project: projectId, p_version: (v?.schedule_version ?? 0) - 1, p_rows: rows });
    expect(stale.data).toBe(false);
    const direct = await alice.from("tasks").update({ is_critical: false }).eq("project_id", projectId);
    expect(direct.error).not.toBeNull(); // engine-owned column
  });

  it("keeps households apart, then lets an invited partner in", async () => {
    const peek = await bob.from("projects").select("id").eq("id", projectId);
    expect(peek.data).toEqual([]);
    const sneak = await bob.from("tasks").update({ title: "pwned" }).eq("project_id", projectId).select("id");
    expect(sneak.data ?? []).toHaveLength(0);

    // Bob already has his own household in this test, so invite a fresh partner instead.
    const partner = `partner+${stamp}@example.com`;
    const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
    await admin.auth.admin.createUser({ email: partner, password: PASSWORD, email_confirm: true });
    const inv = await alice.from("household_invites").insert({ household_id: householdA, email: partner }).select("token").single();
    expect(inv.error).toBeNull();
    const wrong = await bob.rpc("accept_invite", { p_token: inv.data?.token });
    expect(wrong.error?.message).toMatch(/different email/);
    const pc = await signedIn(partner);
    const accepted = await pc.rpc("accept_invite", { p_token: inv.data?.token });
    expect(accepted.data).toBe(householdA);
    const seen = await pc.from("projects").select("id").eq("id", projectId);
    expect(seen.data).toHaveLength(1);
    const members = await pc.from("household_members").select("email").eq("household_id", householdA);
    expect((members.data ?? []).map((m) => m.email).sort()).toEqual([users.alice, partner].sort());
  });

  it("stores files privately per household", async () => {
    const path = `${householdA}/${ids()}/plan.pdf`;
    const body = new Blob(["%PDF-1.4 test"], { type: "application/pdf" });
    const up = await alice.storage.from("attachments").upload(path, body, { contentType: "application/pdf" });
    expect(up.error).toBeNull();
    const att = await alice.from("attachments").insert({ household_id: householdA, storage_path: path, mime: "application/pdf", bytes: 13, kind: "drawing" }).select("id").single();
    expect(att.error).toBeNull();
    const link = await alice.from("attachment_links").insert({ household_id: householdA, attachment_id: att.data?.id, project_id: projectId });
    expect(link.error).toBeNull();

    const bobRead = await bob.storage.from("attachments").download(path);
    expect(bobRead.error).not.toBeNull();
    const { data: bobsHousehold } = await bob.rpc("my_household");
    const bobWrite = await alice.storage.from("attachments").upload(`${bobsHousehold}/${ids()}/x.pdf`, body, { contentType: "application/pdf" });
    expect(bobWrite.error).not.toBeNull();
    const signed = await alice.storage.from("attachments").createSignedUrl(path, 60);
    expect(signed.data?.signedUrl).toMatch(/^http/);
  });
});
