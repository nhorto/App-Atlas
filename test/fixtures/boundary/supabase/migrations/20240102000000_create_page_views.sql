create table public.page_views (
  id bigint generated always as identity,
  path text not null,
  session_id uuid references public.sessions (id) on delete cascade,
  at timestamptz default now(),
  constraint page_views_pkey primary key (id)
);

alter table public.page_views enable row level security;

-- A trigger function: semicolons inside, must be skipped whole.
create or replace function public.touch_page_view() returns trigger as $fn$
begin
  new.at := now();
  return new;
end;
$fn$ language plpgsql;
