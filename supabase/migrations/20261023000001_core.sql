create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table public.voice_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  locale text not null default 'en',
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  -- Paths in the voice-samples bucket.
  sample_path text,
  clone_path text,
  created_at timestamptz not null default now()
);

create table public.phrases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  text text not null,
  locale text not null default 'en',
  created_at timestamptz not null default now()
);

-- Same key as the phone's clip cache, so the server can reuse a clip instead of resynthesizing.
create table public.audio_clips (
  id uuid primary key default gen_random_uuid(),
  voice_profile_id uuid not null references public.voice_profiles (id) on delete cascade,
  locale text not null,
  text_hash text not null, -- hex SHA-256 of the exact text
  storage_path text not null,
  created_at timestamptz not null default now(),
  unique (voice_profile_id, locale, text_hash)
);

alter table public.users enable row level security;
alter table public.voice_profiles enable row level security;
alter table public.phrases enable row level security;
-- No policies: only the server (service role) touches clips.
alter table public.audio_clips enable row level security;

create policy "own row" on public.users
  for all to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- The server writes profiles with the service role; the phone only watches status.
create policy "read own" on public.voice_profiles
  for select to authenticated using (user_id = auth.uid());

create policy "own rows" on public.phrases
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
