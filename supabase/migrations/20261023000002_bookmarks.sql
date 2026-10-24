create table public.bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  phrase_id uuid not null references public.phrases (id) on delete cascade,
  position int not null,
  created_at timestamptz not null default now(),
  -- Checked at statement end, so a reorder can renumber every row in one upsert.
  unique (user_id, position) deferrable initially immediate,
  unique (user_id, phrase_id)
);

alter table public.bookmarks enable row level security;

create policy "own rows" on public.bookmarks
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Every new account, anonymous ones included, gets a users row and the starter bookmarks.
create function public.handle_new_user() returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  starter text[] := array[
    'I need water',
    'I need to use the bathroom',
    'Hi judges, I''ll be demoing Cadence'
  ];
begin
  insert into public.users (id) values (new.id);

  with inserted as (
    insert into public.phrases (user_id, text)
    select new.id, s.text from unnest(starter) as s (text)
    returning id, text
  )
  insert into public.bookmarks (user_id, phrase_id, position)
  select new.id, inserted.id, s.position
  from inserted
  join unnest(starter) with ordinality as s (text, position) using (text);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
