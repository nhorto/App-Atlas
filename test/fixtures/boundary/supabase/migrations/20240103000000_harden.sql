-- Shouted, and split over two lines, the way half the generators out there write it.
ALTER TABLE public.page_views ADD COLUMN IF NOT EXISTS referrer TEXT;
ALTER TABLE public.page_views ADD COLUMN IF NOT EXISTS seen_at TIMESTAMP
  WITH TIME ZONE;
alter table public.page_views alter column path set data type VARCHAR(2048);

-- A storage bucket policy: `storage.objects` is Supabase's table, not this repo's.
create policy "chat photos are private" on storage.objects
  for select using (bucket_id = 'chat-photos');
