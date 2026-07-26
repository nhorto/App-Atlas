-- Visitor sessions, the parent of every page view.
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  started_at timestamptz not null default now(),
  unique (user_email)
);

alter table public.sessions enable row level security;

create policy "own sessions" on public.sessions
  for select using (auth.email() = user_email);

comment on table public.sessions is 'One row per visitor session.';
