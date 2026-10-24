create extension if not exists vector with schema extensions;

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  summary text not null,
  created_at timestamptz not null default now(),
  -- 768 = EmbeddingGemma's output size; stays null until semantic retrieval is added.
  embedding extensions.vector(768)
);

create index memories_user_recent on public.memories (user_id, created_at desc);

alter table public.memories enable row level security;

create policy "own rows" on public.memories
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
