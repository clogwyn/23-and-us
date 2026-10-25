-- ════════════════════════════════════════════════════════════════════════════
-- 23 & Us · private file storage
-- Object keys: <household_id>/<attachment_id>/<filename>
-- Access follows household membership; files are only ever served via signed URLs.
-- ════════════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'attachments', 'attachments', false, 52428800,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/plain','text/csv']
)
on conflict (id) do nothing;

-- First path segment as a household id, or null if it isn't a uuid.
create or replace function public.object_household(p_name text) returns uuid
language plpgsql immutable as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when invalid_text_representation then
  return null;
end $$;

create policy attachments_read on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and public.is_member(public.object_household(name)));

create policy attachments_write on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and public.is_member(public.object_household(name)));

create policy attachments_update on storage.objects for update to authenticated
  using (bucket_id = 'attachments' and public.is_member(public.object_household(name)))
  with check (bucket_id = 'attachments' and public.is_member(public.object_household(name)));

create policy attachments_delete on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and public.is_member(public.object_household(name)));
