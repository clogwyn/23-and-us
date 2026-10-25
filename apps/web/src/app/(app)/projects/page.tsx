import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatGBP, parseGBP, pence, isDayDate, todayIn, formatDayDate, type DayDate } from "@23andus/domain";
import { requireHousehold } from "@/lib/household";

export const metadata: Metadata = { title: "Projects" };

async function createProject(formData: FormData) {
  "use server";
  const { sb, householdId, user } = await requireHousehold();
  const name = String(formData.get("name") ?? "").trim();
  const start = String(formData.get("start") ?? "");
  const deadline = String(formData.get("deadline") ?? "");
  const budgetRaw = String(formData.get("budget") ?? "").trim();
  if (!name) throw new Error("Give the project a name.");
  if (!isDayDate(start)) throw new Error("Choose a start date.");
  if (deadline && (!isDayDate(deadline) || deadline < start)) throw new Error("The deadline must be on or after the start date.");
  const budget = budgetRaw ? parseGBP(budgetRaw) : null;
  if (budgetRaw && budget === null) throw new Error("Enter the budget as pounds, e.g. 18,500.");

  const { data, error } = await sb
    .from("projects")
    .insert({ household_id: householdId, name, start_date: start, deadline: deadline || null, budget_pence: budget, created_by: user.id, status: "planning" })
    .select("id")
    .single();
  if (error) throw new Error(`Couldn't create the project: ${error.message}`);
  redirect(`/projects/${data.id}`);
}

export default async function Projects() {
  const { sb } = await requireHousehold();
  const [{ data: projects }, { data: budgets }, { data: taskStats }] = await Promise.all([
    sb.from("projects").select("id, name, status, start_date, deadline, budget_pence").neq("status", "archived").order("start_date"),
    sb.from("v_project_budget").select("project_id, estimate_pence, actual_pence, budget_pence"),
    sb.from("tasks").select("project_id, status, early_finish, is_critical, is_summary"),
  ]);
  const b = new Map((budgets ?? []).map((r) => [r.project_id, r]));
  const stats = new Map<string, { total: number; done: number; finish: string | null }>();
  for (const t of taskStats ?? []) {
    if (t.is_summary) continue;
    const s = stats.get(t.project_id) ?? { total: 0, done: 0, finish: null };
    s.total++;
    if (t.status === "done") s.done++;
    if (t.early_finish && (!s.finish || t.early_finish > s.finish)) s.finish = t.early_finish;
    stats.set(t.project_id, s);
  }
  const today = todayIn();

  return (
    <main className="page">
      <header className="page-head">
        <h1>Projects</h1>
      </header>

      {(projects ?? []).length === 0 ? (
        <p className="empty-state">No projects yet. Create the first one below, for example "Kitchen &amp; rear extension".</p>
      ) : (
        <ul className="project-list">
          {(projects ?? []).map((p) => {
            const money = b.get(p.id);
            const s = stats.get(p.id);
            const spent = money?.actual_pence ?? 0;
            const budget = p.budget_pence as number | null;
            const pct = budget ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
            const over = budget !== null && spent > budget;
            const late = p.deadline && s?.finish && s.finish > p.deadline;
            return (
              <li key={p.id}>
                <Link href={`/projects/${p.id}`} className="project-card">
                  <div className="pc-main">
                    <h2>{p.name}</h2>
                    <p className="muted">
                      Starts {formatDayDate(p.start_date as DayDate)}
                      {p.deadline ? `, due ${formatDayDate(p.deadline as DayDate)}` : ""}
                      {p.start_date > today ? "" : s?.finish ? `, forecast ${formatDayDate(s.finish as DayDate)}` : ""}
                    </p>
                  </div>
                  <dl className="pc-figs">
                    <div><dt>Tasks</dt><dd>{s ? `${s.done} of ${s.total} done` : "None yet"}</dd></div>
                    <div><dt>Budget</dt><dd>{budget !== null ? formatGBP(pence(budget), { whole: true }) : "Not set"}</dd></div>
                    <div><dt>Spent</dt><dd className={over ? "neg" : ""}>{formatGBP(pence(spent), { whole: true })}</dd></div>
                    <div><dt>Forecast</dt><dd className={late ? "neg" : ""}>{late ? "Late" : s?.finish ? "On time" : "—"}</dd></div>
                  </dl>
                  {budget !== null && <span className={`pc-meter ${over ? "over" : ""}`} style={{ ["--pct" as string]: `${pct}%` }} aria-label={`${pct}% of budget spent`} />}
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <section className="panel">
        <h2>New project</h2>
        <form action={createProject} className="form grid">
          <label htmlFor="pName">Name<input id="pName" name="name" required maxLength={200} placeholder="Bathroom refit" /></label>
          <label htmlFor="pStart">Start<input id="pStart" name="start" type="date" required defaultValue={today} /></label>
          <label htmlFor="pDeadline">Deadline (optional)<input id="pDeadline" name="deadline" type="date" /></label>
          <label htmlFor="pBudget">Budget, £ (optional)<input id="pBudget" name="budget" inputMode="decimal" placeholder="18,500" /></label>
          <div className="form-actions"><button className="btn btn-primary">Create project</button></div>
        </form>
      </section>
    </main>
  );
}
