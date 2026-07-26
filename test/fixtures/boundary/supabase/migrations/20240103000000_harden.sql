alter table public.page_views add column if not exists referrer text;
alter table public.page_views alter column path set data type varchar(2048);

-- A storage bucket policy: `storage.objects` is Supabase's table, not this repo's.
create policy "chat photos are private" on storage.objects
  for select using (bucket_id = 'chat-photos');
