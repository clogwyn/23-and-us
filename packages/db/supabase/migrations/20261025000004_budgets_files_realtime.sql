-- ════════════════════════════════════════════════════════════════════════════
-- 23 & Us · project budgets, document kinds, default rooms, live sync
-- ════════════════════════════════════════════════════════════════════════════

-- ── Project budget (gross pence) ─────────────────────────────────────────────
alter table public.projects
  add column budget_pence bigint check (budget_pence is null or budget_pence >= 0);
grant update (budget_pence) on public.projects to authenticated;

-- Budget columns appended (create or replace view may only add columns at the end).
create or replace view public.v_project_budget with (security_invoker = true) as
select p.id as project_id,
       p.household_id,
       coalesce(sum(cl.estimate_pence), 0)::bigint                        as estimate_pence,
       coalesce(sum(cl.actual_pence), 0)::bigint                          as actual_pence,
       (coalesce(sum(cl.actual_pence), 0) - coalesce(sum(cl.estimate_pence), 0))::bigint as variance_pence,
       round(coalesce(sum(cl.estimate_pence), 0) * p.contingency_pct / 100)::bigint     as contingency_pence,
       (coalesce(sum(cl.estimate_pence), 0)
         + round(coalesce(sum(cl.estimate_pence), 0) * p.contingency_pct / 100)
         - coalesce(sum(cl.actual_pence), 0))::bigint                     as headroom_pence,
       p.budget_pence,
       (p.budget_pence - coalesce(sum(cl.actual_pence), 0))::bigint       as budget_remaining_pence,
       (p.budget_pence - coalesce(sum(cl.estimate_pence), 0))::bigint     as budget_vs_estimate_pence
  from public.projects p
  left join public.cost_lines cl on cl.project_id = p.id
 group by p.id;

-- ── Document kinds: plans and UK certificates ────────────────────────────────
alter table public.attachments drop constraint attachments_kind_check;
alter table public.attachments add constraint attachments_kind_check
  check (kind in ('photo','drawing','quote','invoice','warranty','certificate','document','other'));

-- ── Member emails, so the household page can say who's in it ────────────────
alter table public.household_members add column email text;
update public.household_members m set email = u.email from auth.users u where u.id = m.user_id;

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
  insert into public.household_members (household_id, user_id, email) values (inv.household_id, uid, em)
    on conflict (household_id, user_id) do update set email = excluded.email;
  update public.household_invites set accepted_at = now(), accepted_by = uid where id = inv.id;
  return inv.household_id;
end $$;

-- ── Default rooms for a new household ────────────────────────────────────────
create or replace function public.create_household(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare h uuid; uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  -- Idempotent: someone who already belongs to a household gets that one back.
  select household_id into h from public.household_members where user_id = uid order by created_at limit 1;
  if h is not null then return h; end if;
  insert into public.households (name) values (p_name) returning id into h;
  insert into public.household_members (household_id, user_id, email)
    values (h, uid, (select email from auth.users where id = uid));
  insert into public.cost_categories (household_id, name, sort)
    select h, c.name, c.ord * 1024
      from unnest(array['Labour','Materials','Fixtures & fittings','Appliances','Professional fees',
                        'Permits & certificates','Skips & waste','Tool hire','Contingency draw','Other'])
           with ordinality as c(name, ord);
  insert into public.areas (household_id, name, sort)
    select h, a.name, a.ord * 1024
      from unnest(array['Kitchen','Living room','Hall & stairs','Bathroom','Bedrooms','Utility',
                        'Rear extension','Whole house','Outside'])
           with ordinality as a(name, ord);
  return h;
end $$;

-- The household the signed-in user belongs to (the app has no household switcher yet).
create or replace function public.my_household() returns uuid
language sql stable security definer set search_path = '' as $$
  select household_id from public.household_members where user_id = (select auth.uid())
  order by created_at limit 1
$$;
grant execute on function public.my_household() to authenticated;

-- ── Live sync between household members ──────────────────────────────────────
-- Realtime respects RLS, so each member only receives their own household's rows.
alter publication supabase_realtime add table
  public.projects, public.tasks, public.task_dependencies, public.cost_lines,
  public.attachments, public.attachment_links, public.task_notes;
