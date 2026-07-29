-- No `enable row level security` anywhere: PostgREST publishes this table to anyone
-- holding the anon key, which ships to the browser. The open door this fixture exists
-- to prove App Atlas will name out loud.
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor text not null,
  action text not null,
  created_at timestamp with time zone default now()
);
