-- ════════════════════════════════════════════════════════════════════════════
-- Reno · core schema
--
-- Principles
--  • Every row carries household_id; composite FKs make it impossible for a row to
--    point at another household's project/task/area.
--  • Enumerations are text + CHECK (cheap to evolve, unlike Postgres enums).
--  • Money is bigint pence, gross. Dates are `date` (no time zone).
--  • Engine-owned task columns are not writable by clients (column privileges);
--    only apply_schedule() writes them, guarded by an optimistic schedule_version.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Utilities ────────────────────────────────────────────────────────────────
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ── Households ───────────────────────────────────────────────────────────────
create table public.households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 120),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index on public.household_members (user_id);

-- SECURITY DEFINER so policies can call it without recursing through RLS.
create or replace function public.is_member(h uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = h and m.user_id = (select auth.uid())
  )
$$;

create table public.household_invites (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  email        text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  token        text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '14 days',
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id) on delete set null
);

-- ── Areas (rooms) ────────────────────────────────────────────────────────────
create table public.areas (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  parent_id    uuid,
  name         text not null check (length(trim(name)) between 1 and 120),
  sort         double precision not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, household_id),
  foreign key (parent_id, household_id) references public.areas(id, household_id) on delete cascade
);
create index on public.areas (household_id, parent_id, sort);

-- ── Calendars (global reference data) ────────────────────────────────────────
create table public.calendars (
  id    text primary key,
  name  text not null
);
insert into public.calendars (id, name) values ('all-days', 'Every day');

create table public.calendar_exceptions (
  calendar_id text not null references public.calendars(id) on delete cascade,
  day         date not null,
  is_working  boolean not null,
  label       text not null default '',
  primary key (calendar_id, day)
);

-- ── Projects ─────────────────────────────────────────────────────────────────
create table public.projects (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references public.households(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 200),
  status           text not null default 'planning'
                   check (status in ('planning','active','on_hold','complete','archived')),
  start_date       date not null,
  deadline         date,
  contingency_pct  numeric(5,2) not null default 10 check (contingency_pct between 0 and 100),
  calendar_id      text not null default 'all-days' references public.calendars(id),
  notes            text not null default '',
  -- Bumped on every schedule-affecting change; apply_schedule() refuses stale results.
  schedule_version bigint not null default 0,
  scheduled_version bigint,
  scheduled_at     timestamptz,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, household_id),
  check (deadline is null or deadline >= start_date)
);
create index on public.projects (household_id, status);

-- ── Tasks ────────────────────────────────────────────────────────────────────
create table public.tasks (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null,
  project_id       uuid not null,
  parent_id        uuid,
  sort             double precision not null default 0,
  title            text not null check (length(trim(title)) between 1 and 200),
  description      text not null default '',
  status           text not null default 'todo'
                   check (status in ('todo','in_progress','blocked','done','cancelled')),
  priority         text not null default 'normal'
                   check (priority in ('low','normal','high','urgent')),
  area_id          uuid,
  assignee_id      uuid references auth.users(id) on delete set null,

  -- schedule inputs
  duration_days    integer not null default 1 check (duration_days between 0 and 3650),
  constraint_type  text not null default 'ASAP' check (constraint_type in ('ASAP','SNET','FNET','MSO','MFO')),
  constraint_date  date,
  deadline         date,
  actual_start     date,
  actual_finish    date,
  percent_complete smallint not null default 0 check (percent_complete between 0 and 100),

  -- engine-owned (written only by apply_schedule)
  early_start      date,
  early_finish     date,
  late_start       date,
  late_finish      date,
  total_float      integer,
  free_float       integer,
  is_critical      boolean not null default false,
  is_summary       boolean not null default false,
  computed_at      timestamptz,

  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (id, project_id),
  unique (id, household_id),
  foreign key (project_id, household_id) references public.projects(id, household_id) on delete cascade,
  foreign key (parent_id, project_id)    references public.tasks(id, project_id) on delete cascade,
  foreign key (area_id, household_id)    references public.areas(id, household_id) on delete set null (area_id),
  check ((constraint_type = 'ASAP') = (constraint_date is null)),
  check (actual_finish is null or actual_start is not null),
  check (actual_finish is null or actual_finish >= actual_start)
);
create index on public.tasks (project_id, parent_id, sort);
create index on public.tasks (household_id);
create index on public.tasks (area_id) where area_id is not null;
create index on public.tasks (assignee_id) where assignee_id is not null;

-- A task can't be moved under its own descendant.
create or replace function public.tasks_guard_parent() returns trigger
language plpgsql as $$
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then raise exception 'A task cannot be its own parent' using errcode = '23514'; end if;
  if exists (
    with recursive down as (
      select id from public.tasks where parent_id = new.id
      union all
      select t.id from public.tasks t join down on t.parent_id = down.id
    )
    select 1 from down where id = new.parent_id
  ) then
    raise exception 'A task cannot be moved under its own subtask' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger tasks_guard_parent before insert or update of parent_id on public.tasks
  for each row execute function public.tasks_guard_parent();

-- ── Dependencies ─────────────────────────────────────────────────────────────
create table public.task_dependencies (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null,
  project_id      uuid not null,
  predecessor_id  uuid not null,
  successor_id    uuid not null,
  type            text not null default 'FS' check (type in ('FS','SS','FF','SF')),
  lag_days        integer not null default 0 check (lag_days between -365 and 365),
  created_at      timestamptz not null default now(),
  unique (predecessor_id, successor_id),
  check (predecessor_id <> successor_id),
  foreign key (project_id, household_id)   references public.projects(id, household_id) on delete cascade,
  foreign key (predecessor_id, project_id) references public.tasks(id, project_id) on delete cascade,
  foreign key (successor_id, project_id)   references public.tasks(id, project_id) on delete cascade
);
create index on public.task_dependencies (successor_id);
create index on public.task_dependencies (project_id);

-- Direct-cycle guard. (Cycles that only appear through group expansion are caught by the engine.)
create or replace function public.deps_guard_cycle() returns trigger
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.project_id::text, 0));
  if exists (
    with recursive reach as (
      select successor_id as id from public.task_dependencies
       where predecessor_id = new.successor_id and id <> new.id
      union
      select d.successor_id from public.task_dependencies d
        join reach r on d.predecessor_id = r.id
       where d.id <> new.id
    )
    select 1 from reach where id = new.predecessor_id
  ) or new.successor_id = new.predecessor_id then
    raise exception 'This link would create a loop' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger deps_guard_cycle before insert or update of predecessor_id, successor_id on public.task_dependencies
  for each row execute function public.deps_guard_cycle();

-- ── Schedule versioning ──────────────────────────────────────────────────────
-- SECURITY DEFINER: clients can't write schedule_version directly, but their edits must bump it.
create or replace function public.bump_schedule_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare pid uuid;
begin
  pid := coalesce(new.project_id, old.project_id);
  update public.projects set schedule_version = schedule_version + 1 where id = pid;
  if tg_op = 'UPDATE' and new.project_id is distinct from old.project_id then
    update public.projects set schedule_version = schedule_version + 1 where id = old.project_id;
  end if;
  return null;
end $$;

create trigger tasks_bump_schedule
  after insert or delete or update of parent_id, duration_days, constraint_type, constraint_date,
                                      deadline, actual_start, actual_finish, status, project_id
  on public.tasks for each row execute function public.bump_schedule_version();

create trigger deps_bump_schedule
  after insert or delete or update on public.task_dependencies
  for each row execute function public.bump_schedule_version();

create or replace function public.projects_bump_on_dates() returns trigger
language plpgsql as $$
begin
  if new.start_date is distinct from old.start_date
     or new.deadline is distinct from old.deadline
     or new.calendar_id is distinct from old.calendar_id then
    new.schedule_version := old.schedule_version + 1;
  end if;
  return new;
end $$;

create trigger projects_bump_on_dates before update on public.projects
  for each row execute function public.projects_bump_on_dates();

-- ── Baselines ────────────────────────────────────────────────────────────────
create table public.baselines (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  project_id   uuid not null,
  name         text not null check (length(trim(name)) between 1 and 120),
  captured_by  uuid references auth.users(id) on delete set null,
  captured_at  timestamptz not null default now(),
  unique (id, household_id),
  foreign key (project_id, household_id) references public.projects(id, household_id) on delete cascade
);

create table public.baseline_tasks (
  baseline_id    uuid not null,
  household_id   uuid not null,
  task_id        uuid not null,
  start_date     date,
  finish_date    date,
  duration_days  integer,
  estimate_pence bigint,
  primary key (baseline_id, task_id),
  foreign key (baseline_id, household_id) references public.baselines(id, household_id) on delete cascade,
  foreign key (task_id, household_id)     references public.tasks(id, household_id) on delete cascade
);

-- ── Budget ───────────────────────────────────────────────────────────────────
create table public.cost_categories (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name         text not null check (length(trim(name)) between 1 and 80),
  sort         double precision not null default 0,
  unique (household_id, name),
  unique (id, household_id)
);

create table public.cost_lines (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null,
  project_id     uuid not null,
  task_id        uuid,
  area_id        uuid,
  category_id    uuid not null,
  description    text not null check (length(trim(description)) between 1 and 200),
  estimate_pence bigint,
  actual_pence   bigint,
  supplier_text  text not null default '',
  incurred_on    date,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, household_id),
  foreign key (project_id, household_id)  references public.projects(id, household_id) on delete cascade,
  foreign key (task_id, project_id)       references public.tasks(id, project_id) on delete set null (task_id),
  foreign key (area_id, household_id)     references public.areas(id, household_id) on delete set null (area_id),
  foreign key (category_id, household_id) references public.cost_categories(id, household_id) on delete restrict
);
create index on public.cost_lines (project_id);
create index on public.cost_lines (task_id) where task_id is not null;

-- ── Attachments ──────────────────────────────────────────────────────────────
create table public.attachments (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households(id) on delete cascade,
  -- Object key in the private "attachments" bucket: <household_id>/<attachment_id>/<filename>
  storage_path  text not null unique,
  thumb_path    text,
  mime          text not null,
  bytes         bigint not null check (bytes > 0 and bytes <= 52428800),
  kind          text not null check (kind in ('photo','quote','invoice','drawing','warranty','other')),
  caption       text not null default '',
  taken_at      date,
  width         integer,
  height        integer,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (id, household_id),
  check (split_part(storage_path, '/', 1) = household_id::text)
);

create table public.attachment_links (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null,
  attachment_id  uuid not null,
  project_id     uuid,
  task_id        uuid,
  cost_line_id   uuid,
  created_at     timestamptz not null default now(),
  check (num_nonnulls(project_id, task_id, cost_line_id) = 1),
  foreign key (attachment_id, household_id) references public.attachments(id, household_id) on delete cascade,
  foreign key (project_id, household_id)    references public.projects(id, household_id) on delete cascade,
  foreign key (task_id, household_id)       references public.tasks(id, household_id) on delete cascade,
  foreign key (cost_line_id, household_id)  references public.cost_lines(id, household_id) on delete cascade
);
create unique index on public.attachment_links (attachment_id, project_id)   where project_id is not null;
create unique index on public.attachment_links (attachment_id, task_id)      where task_id is not null;
create unique index on public.attachment_links (attachment_id, cost_line_id) where cost_line_id is not null;
create index on public.attachment_links (task_id) where task_id is not null;

-- ── Notes & activity ─────────────────────────────────────────────────────────
create table public.task_notes (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  task_id      uuid not null,
  author_id    uuid references auth.users(id) on delete set null,
  body         text not null check (length(body) between 1 and 20000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (task_id, household_id) references public.tasks(id, household_id) on delete cascade
);
create index on public.task_notes (task_id, created_at);

create table public.activity_events (
  id           bigint generated always as identity primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  project_id   uuid,
  entity       text not null,
  entity_id    uuid not null,
  verb         text not null,
  diff         jsonb not null default '{}',
  actor_id     uuid references auth.users(id) on delete set null default auth.uid(),
  at           timestamptz not null default now()
);
create index on public.activity_events (household_id, at desc);
create index on public.activity_events (entity, entity_id, at desc);

-- ── updated_at triggers ──────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['households','areas','projects','tasks','cost_lines','task_notes'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.touch_updated_at()', t || '_touch', t);
  end loop;
end $$;
