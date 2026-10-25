-- Security & integrity tests. Each block raises on failure; the runner uses ON_ERROR_STOP.
\set ON_ERROR_STOP on
set client_min_messages = warning;

insert into auth.users values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@example.com'),
  ('00000000-0000-0000-0000-0000000000a2', 'adam@example.com'),
  ('00000000-0000-0000-0000-0000000000b1', 'bob@example.com');

create function pg_temp.as_user(u text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', u, false);
$$;

-- Alice creates a household; Bob creates his own.
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select public.create_household('Glover house') as ha \gset
insert into public.projects (household_id, name, start_date) values (:'ha', 'Kitchen refit', '2026-11-02') returning id as pa \gset
insert into public.tasks (household_id, project_id, title) values (:'ha', :'pa', 'Strip out') returning id as t1 \gset
insert into public.tasks (household_id, project_id, title) values (:'ha', :'pa', 'First fix') returning id as t2 \gset
insert into public.tasks (household_id, project_id, title) values (:'ha', :'pa', 'Plaster') returning id as t3 \gset
insert into public.task_dependencies (household_id, project_id, predecessor_id, successor_id) values (:'ha', :'pa', :'t1', :'t2');
insert into public.task_dependencies (household_id, project_id, predecessor_id, successor_id) values (:'ha', :'pa', :'t2', :'t3');

-- Expose Alice's ids to plpgsql blocks below.
reset role;
select set_config('my.ha', :'ha', false), set_config('my.pa', :'pa', false), set_config('my.t1', :'t1', false);
set role authenticated;

select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select public.create_household('Bob house') as hb \gset

-- ── 1. Isolation: Bob sees nothing of Alice's ───────────────────────────────
do $$ begin
  if (select count(*) from public.projects) <> 0 then raise exception 'FAIL: Bob can see Alice''s projects'; end if;
  if (select count(*) from public.tasks) <> 0 then raise exception 'FAIL: Bob can see Alice''s tasks'; end if;
  if (select count(*) from public.households) <> 1 then raise exception 'FAIL: Bob sees other households'; end if;
  if (select count(*) from public.cost_categories) <> 10 then raise exception 'FAIL: default categories not seeded'; end if;
end $$;

-- ── 2. Bob cannot write into, update or delete from Alice's household ──────
do $$ declare n int; begin
  begin
    insert into public.projects (household_id, name, start_date) values (current_setting('my.ha')::uuid, 'x', '2026-01-01');
    raise exception 'FAIL: cross-household insert allowed';
  exception when insufficient_privilege then null;
  end;
  update public.tasks set title = 'pwned' where id = current_setting('my.t1')::uuid;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: cross-household update'; end if;
  delete from public.projects where id = current_setting('my.pa')::uuid;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: cross-household delete'; end if;
end $$;

-- ── 3. Composite FKs: Bob can't hang a row in HIS household off Alice's project ─
do $$ declare hb uuid := (select id from public.households limit 1); begin
  begin
    insert into public.tasks (household_id, project_id, title) values (hb, current_setting('my.pa')::uuid, 'evil');
    raise exception 'FAIL: task attached to another household''s project';
  exception when foreign_key_violation then null;
  end;
end $$;

-- ── 4. Engine-owned columns are not client-writable ─────────────────────────
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  begin
    update public.tasks set is_critical = true;
    raise exception 'FAIL: client wrote an engine-owned column';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.projects set schedule_version = 999;
    raise exception 'FAIL: client wrote schedule_version';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── 5. Dependency loops are rejected ────────────────────────────────────────
do $$ declare t1 uuid; t3 uuid; ha uuid; pa uuid; begin
  select id, household_id, project_id into t1, ha, pa from public.tasks where title = 'Strip out';
  select id into t3 from public.tasks where title = 'Plaster';
  begin
    insert into public.task_dependencies (household_id, project_id, predecessor_id, successor_id) values (ha, pa, t3, t1);
    raise exception 'FAIL: cycle accepted';
  exception when check_violation then null;
  end;
end $$;

-- ── 6. Parent loops are rejected ────────────────────────────────────────────
do $$ declare a uuid; b uuid; begin
  select id into a from public.tasks where title = 'Strip out';
  select id into b from public.tasks where title = 'First fix';
  update public.tasks set parent_id = a where id = b;
  begin
    update public.tasks set parent_id = b where id = a;
    raise exception 'FAIL: parent cycle accepted';
  exception when check_violation then null;
  end;
  update public.tasks set parent_id = null where id = b;
end $$;

-- ── 7. Schedule versioning & optimistic apply ───────────────────────────────
do $$ declare pid uuid; v bigint; ok boolean; t uuid; begin
  select id, schedule_version into pid, v from public.projects where name = 'Kitchen refit';
  select id into t from public.tasks where title = 'Strip out';

  ok := public.apply_schedule(pid, v, jsonb_build_array(jsonb_build_object(
          'id', t, 'early_start', '2026-11-02', 'early_finish', '2026-11-04',
          'late_start', '2026-11-02', 'late_finish', '2026-11-04',
          'total_float', 0, 'free_float', 0, 'is_critical', true, 'is_summary', false)));
  if not ok then raise exception 'FAIL: fresh apply refused'; end if;
  if not (select is_critical from public.tasks where id = t) then raise exception 'FAIL: apply did not write'; end if;
  if (select schedule_version from public.projects where id = pid) <> v then raise exception 'FAIL: apply bumped its own version'; end if;

  update public.tasks set duration_days = 5 where id = t;  -- an edit lands
  if (select schedule_version from public.projects where id = pid) <= v then raise exception 'FAIL: edit did not bump version'; end if;
  if public.apply_schedule(pid, v, '[]'::jsonb) then raise exception 'FAIL: stale apply accepted'; end if;

  update public.tasks set title = 'Strip out (all)' where id = t;  -- non-schedule edit
  v := (select schedule_version from public.projects where id = pid);
  update public.tasks set description = 'skip + dust sheets' where id = t;
  if (select schedule_version from public.projects where id = pid) <> v then raise exception 'FAIL: cosmetic edit bumped version'; end if;
end $$;

-- ── 8. Budget roll-ups ──────────────────────────────────────────────────────
do $$ declare pid uuid; hid uuid; parent uuid; child uuid; cat uuid; b record; r record; begin
  select id, household_id into pid, hid from public.projects where name = 'Kitchen refit';
  select id into cat from public.cost_categories where name = 'Labour' and household_id = hid;
  insert into public.tasks (household_id, project_id, title) values (hid, pid, 'Electrics') returning id into parent;
  insert into public.tasks (household_id, project_id, parent_id, title) values (hid, pid, parent, 'Rewire') returning id into child;
  insert into public.cost_lines (household_id, project_id, task_id, category_id, description, estimate_pence, actual_pence)
    values (hid, pid, child, cat, 'Electrician', 250000, 275050),
           (hid, pid, parent, cat, 'Certificate', 15000, null),
           (hid, pid, null, cat, 'Skip', 30000, 32000);

  select * into r from public.v_task_cost_rollup where task_id = parent;
  if r.estimate_pence <> 265000 or r.actual_pence <> 275050 then raise exception 'FAIL: task rollup %', row_to_json(r); end if;

  select * into b from public.v_project_budget where project_id = pid;
  if b.estimate_pence <> 295000 or b.actual_pence <> 307050 or b.variance_pence <> 12050
     or b.contingency_pence <> 29500 or b.headroom_pence <> 17450 then
    raise exception 'FAIL: project budget %', row_to_json(b);
  end if;
end $$;

-- ── 9. Bob still can't see Alice's budget via views ─────────────────────────
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ begin
  if exists (select 1 from public.v_project_budget where estimate_pence > 0) then raise exception 'FAIL: view leaks across households'; end if;
  if exists (select 1 from public.v_task_cost_rollup) then raise exception 'FAIL: rollup view leaks'; end if;
end $$;

-- ── 10. Invites: only the named email can accept ────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
insert into public.household_invites (household_id, email) values (:'ha', 'adam@example.com') returning token as tok \gset
reset role;
select set_config('my.tok', :'tok', false);
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ begin
  begin
    perform public.accept_invite(current_setting('my.tok'));
    raise exception 'FAIL: wrong user accepted invite';
  exception when insufficient_privilege then null;
  end;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
select public.accept_invite(:'tok') = :'ha'::uuid as accepted \gset
do $$ begin
  if (select count(*) from public.projects) <> 1 then raise exception 'FAIL: invited member cannot see project'; end if;
end $$;

-- ── 11. Storage: path prefix must be your household ─────────────────────────
do $$ declare h uuid := (select id from public.households limit 1); begin
  insert into storage.objects (bucket_id, name) values ('attachments', h || '/x/photo.jpg');
  begin
    insert into storage.objects (bucket_id, name) values ('attachments', gen_random_uuid() || '/x/photo.jpg');
    raise exception 'FAIL: wrote outside own household';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name) values ('attachments', 'not-a-uuid/x.jpg');
    raise exception 'FAIL: wrote with junk prefix';
  exception when insufficient_privilege then null;
  end;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ begin
  if exists (select 1 from storage.objects) then raise exception 'FAIL: Bob can list Alice''s files'; end if;
end $$;

-- ── 12. Anonymous gets nothing ──────────────────────────────────────────────
reset role;
set role anon;
do $$ begin
  begin
    perform 1 from public.projects;
    raise exception 'FAIL: anon can read projects';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- ── 13. Budgets, rooms, document kinds, idempotent onboarding ───────────────
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare pid uuid; hid uuid; b record; again uuid; begin
  select id, household_id into pid, hid from public.projects where name = 'Kitchen refit';
  update public.projects set budget_pence = 400000 where id = pid;
  select * into b from public.v_project_budget where project_id = pid;
  if b.budget_pence <> 400000 or b.budget_remaining_pence <> 400000 - 307050 or b.budget_vs_estimate_pence <> 400000 - 295000 then
    raise exception 'FAIL: budget view %', row_to_json(b);
  end if;
  if (select count(*) from public.areas where household_id = hid) <> 9 then raise exception 'FAIL: default rooms not seeded'; end if;
  insert into public.attachments (household_id, storage_path, mime, bytes, kind)
    values (hid, hid || '/' || gen_random_uuid() || '/part-p.pdf', 'application/pdf', 1024, 'certificate');
  again := public.create_household('Second try');
  if again <> hid then raise exception 'FAIL: create_household made a second household'; end if;
  if public.my_household() <> hid then raise exception 'FAIL: my_household'; end if;
  if (select count(*) from public.household_members where household_id = hid and email is not null) <> 2 then raise exception 'FAIL: member emails'; end if;
  begin
    insert into public.attachments (household_id, storage_path, mime, bytes, kind)
      values (hid, hid || '/' || gen_random_uuid() || '/x.mp4', 'video/mp4', 1024, 'video');
    raise exception 'FAIL: unknown kind accepted';
  exception when check_violation then null;
  end;
end $$;
reset role;
\echo 'ALL SECURITY TESTS PASSED'
