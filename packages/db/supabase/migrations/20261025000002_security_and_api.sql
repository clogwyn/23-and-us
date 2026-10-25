-- ════════════════════════════════════════════════════════════════════════════
-- 23 & Us · row-level security, privileges, RPCs and roll-up views
-- ════════════════════════════════════════════════════════════════════════════

-- ── Privileges ───────────────────────────────────────────────────────────────
-- No anonymous access to anything.
revoke all on all tables    in schema public from anon;
revoke all on all functions in schema public from anon;

-- Engine-owned task columns: clients may insert/update inputs only.
revoke insert, update on public.tasks from authenticated;
grant insert (id, household_id, project_id, parent_id, sort, title, description, status, priority,
              area_id, assignee_id, duration_days, constraint_type, constraint_date, deadline,
              actual_start, actual_finish, percent_complete, created_by)
  on public.tasks to authenticated;
grant update (parent_id, sort, title, description, status, priority, area_id, assignee_id,
              duration_days, constraint_type, constraint_date, deadline, actual_start,
              actual_finish, percent_complete)
  on public.tasks to authenticated;

-- schedule_version is server-managed.
revoke update on public.projects from authenticated;
grant update (name, status, start_date, deadline, contingency_pct, calendar_id, notes) on public.projects to authenticated;

-- Membership and activity are written by functions/triggers, not directly.
revoke insert, update, delete on public.household_members from authenticated;
revoke update, delete on public.activity_events from authenticated;
revoke insert, update, delete on public.calendars, public.calendar_exceptions from authenticated;

-- ── RLS ──────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'areas','projects','tasks','task_dependencies','baselines','baseline_tasks',
    'cost_categories','cost_lines','attachments','attachment_links','task_notes'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (public.is_member(household_id)) with check (public.is_member(household_id))',
      t || '_member', t);
  end loop;
end $$;

alter table public.households enable row level security;
create policy households_member_read   on public.households for select to authenticated using (public.is_member(id));
create policy households_member_update on public.households for update to authenticated using (public.is_member(id)) with check (public.is_member(id));

alter table public.household_members enable row level security;
create policy members_read on public.household_members for select to authenticated using (public.is_member(household_id));

alter table public.household_invites enable row level security;
create policy invites_member on public.household_invites for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

alter table public.activity_events enable row level security;
create policy activity_read   on public.activity_events for select to authenticated using (public.is_member(household_id));
create policy activity_insert on public.activity_events for insert to authenticated with check (public.is_member(household_id) and actor_id = (select auth.uid()));

alter table public.calendars enable row level security;
create policy calendars_read on public.calendars for select to authenticated using (true);
alter table public.calendar_exceptions enable row level security;
create policy calendar_exceptions_read on public.calendar_exceptions for select to authenticated using (true);

-- ── Household bootstrap & invites ────────────────────────────────────────────
create or replace function public.create_household(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare h uuid; uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  insert into public.households (name) values (p_name) returning id into h;
  insert into public.household_members (household_id, user_id) values (h, uid);
  insert into public.cost_categories (household_id, name, sort)
    select h, c.name, c.ord * 1024
      from unnest(array['Labour','Materials','Fixtures & fittings','Appliances','Professional fees',
                        'Permits & certificates','Skips & waste','Tool hire','Contingency draw','Other'])
           with ordinality as c(name, ord);
  return h;
end $$;

create or replace function public.accept_invite(p_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare inv public.household_invites; uid uuid := (select auth.uid()); em text;
begin
  if uid is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  select * into inv from public.household_invites
   where token = p_token and accepted_at is null and expires_at > now()
   for update;
  if not found then raise exception 'Invite is invalid or has expired' using errcode = 'P0002'; end if;
  select email into em from auth.users where id = uid;
  if lower(em) is distinct from lower(inv.email) then
    raise exception 'This invite was sent to a different email address' using errcode = '42501';
  end if;
  insert into public.household_members (household_id, user_id) values (inv.household_id, uid)
    on conflict do nothing;
  update public.household_invites set accepted_at = now(), accepted_by = uid where id = inv.id;
  return inv.household_id;
end $$;

-- ── Scheduling write path ────────────────────────────────────────────────────
-- The app computes the schedule with @23andus/scheduler, then submits it here.
-- p_version must equal the projects.schedule_version it read; if an edit landed
-- in between, nothing is written and false is returned (caller recomputes).
--
-- p_rows: [{ "id", "early_start", "early_finish", "late_start", "late_finish",
--            "total_float", "free_float", "is_critical", "is_summary" }, …]
create or replace function public.apply_schedule(p_project uuid, p_version bigint, p_rows jsonb)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare pr public.projects;
begin
  select * into pr from public.projects where id = p_project for update;
  if not found or not public.is_member(pr.household_id) then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  if pr.schedule_version <> p_version then
    return false;
  end if;

  update public.tasks t set
    early_start  = r.early_start,
    early_finish = r.early_finish,
    late_start   = r.late_start,
    late_finish  = r.late_finish,
    total_float  = r.total_float,
    free_float   = r.free_float,
    is_critical  = r.is_critical,
    is_summary   = r.is_summary,
    computed_at  = now()
  from jsonb_to_recordset(p_rows) as r(
    id uuid, early_start date, early_finish date, late_start date, late_finish date,
    total_float integer, free_float integer, is_critical boolean, is_summary boolean)
  where t.id = r.id and t.project_id = p_project;

  -- Tasks the engine didn't schedule (e.g. cancelled) lose stale computed values.
  update public.tasks t set
    early_start = null, early_finish = null, late_start = null, late_finish = null,
    total_float = null, free_float = null, is_critical = false, computed_at = now()
  where t.project_id = p_project
    and not exists (select 1 from jsonb_array_elements(p_rows) e where (e->>'id')::uuid = t.id);

  update public.projects set scheduled_version = p_version, scheduled_at = now() where id = p_project;
  return true;
end $$;

create or replace function public.capture_baseline(p_project uuid, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare pr public.projects; b uuid;
begin
  select * into pr from public.projects where id = p_project;
  if not found or not public.is_member(pr.household_id) then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  if pr.scheduled_version is distinct from pr.schedule_version then
    raise exception 'Schedule is out of date; recalculate before capturing a baseline' using errcode = '55000';
  end if;
  insert into public.baselines (household_id, project_id, name, captured_by)
    values (pr.household_id, p_project, p_name, (select auth.uid())) returning id into b;
  insert into public.baseline_tasks (baseline_id, household_id, task_id, start_date, finish_date, duration_days, estimate_pence)
    select b, t.household_id, t.id, t.early_start, t.early_finish,
           case when t.early_start is null then null else t.early_finish - t.early_start + 1 end,
           r.estimate_pence
      from public.tasks t
      left join public.v_task_cost_rollup r on r.task_id = t.id
     where t.project_id = p_project;
  return b;
end $$;

-- ── Roll-up views (security_invoker ⇒ caller's RLS applies) ─────────────────
create view public.v_task_cost_rollup with (security_invoker = true) as
with recursive closure as (
  select id as ancestor_id, id as task_id from public.tasks
  union all
  select c.ancestor_id, t.id from public.tasks t join closure c on t.parent_id = c.task_id
)
select c.ancestor_id                       as task_id,
       coalesce(sum(cl.estimate_pence), 0)::bigint as estimate_pence,
       coalesce(sum(cl.actual_pence), 0)::bigint   as actual_pence,
       count(cl.id)::integer               as line_count
  from closure c
  left join public.cost_lines cl on cl.task_id = c.task_id
 group by c.ancestor_id;

create view public.v_project_budget with (security_invoker = true) as
select p.id as project_id,
       p.household_id,
       coalesce(sum(cl.estimate_pence), 0)::bigint                        as estimate_pence,
       coalesce(sum(cl.actual_pence), 0)::bigint                          as actual_pence,
       (coalesce(sum(cl.actual_pence), 0) - coalesce(sum(cl.estimate_pence), 0))::bigint as variance_pence,
       round(coalesce(sum(cl.estimate_pence), 0) * p.contingency_pct / 100)::bigint     as contingency_pence,
       (coalesce(sum(cl.estimate_pence), 0)
         + round(coalesce(sum(cl.estimate_pence), 0) * p.contingency_pct / 100)
         - coalesce(sum(cl.actual_pence), 0))::bigint                     as headroom_pence
  from public.projects p
  left join public.cost_lines cl on cl.project_id = p.id
 group by p.id;

create view public.v_area_budget with (security_invoker = true) as
select cl.household_id, cl.project_id, cl.area_id,
       sum(coalesce(cl.estimate_pence, 0))::bigint as estimate_pence,
       sum(coalesce(cl.actual_pence, 0))::bigint   as actual_pence
  from public.cost_lines cl
 group by cl.household_id, cl.project_id, cl.area_id;

create view public.v_category_budget with (security_invoker = true) as
select cl.household_id, cl.project_id, cl.category_id,
       sum(coalesce(cl.estimate_pence, 0))::bigint as estimate_pence,
       sum(coalesce(cl.actual_pence, 0))::bigint   as actual_pence
  from public.cost_lines cl
 group by cl.household_id, cl.project_id, cl.category_id;

grant select on public.v_task_cost_rollup, public.v_project_budget, public.v_area_budget, public.v_category_budget to authenticated;
grant execute on function public.create_household(text), public.accept_invite(text),
                          public.apply_schedule(uuid, bigint, jsonb), public.capture_baseline(uuid, text),
                          public.is_member(uuid)
  to authenticated;
