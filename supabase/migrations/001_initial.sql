-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ============================================================
-- TABLES
-- ============================================================

create table public.tags (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references auth.users(id) on delete cascade not null,
  name        text not null,
  color       text not null default '#3ea6ff',
  created_at  timestamptz default now() not null,
  constraint tags_user_name_unique unique (user_id, name)
);

create table public.channels (
  id              uuid default gen_random_uuid() primary key,
  user_id         uuid references auth.users(id) on delete cascade not null,
  yt_channel_id   text,
  name            text not null,
  handle          text,
  thumbnail       text,
  description     text,
  sorted          boolean default false not null,
  created_at      timestamptz default now() not null
);

-- Partial unique indexes (allows null yt_channel_id / handle without conflict)
create unique index channels_user_ytid_idx  on public.channels(user_id, yt_channel_id) where yt_channel_id is not null;
create unique index channels_user_handle_idx on public.channels(user_id, handle)        where handle is not null;
create unique index channels_user_name_idx   on public.channels(user_id, name);

create table public.channel_tags (
  channel_id  uuid references public.channels(id) on delete cascade not null,
  tag_id      uuid references public.tags(id)     on delete cascade not null,
  primary key (channel_id, tag_id)
);

create table public.channel_stats (
  channel_id          uuid references public.channels(id) on delete cascade primary key,
  user_id             uuid references auth.users(id) on delete cascade not null,
  watch_count         integer default 0 not null,
  last_watched_at     timestamptz,
  last_seen_in_feed_at timestamptz
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.tags          enable row level security;
alter table public.channels      enable row level security;
alter table public.channel_tags  enable row level security;
alter table public.channel_stats enable row level security;

create policy "own tags"          on public.tags          for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own channels"      on public.channels      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own channel_stats" on public.channel_stats for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own channel_tags"  on public.channel_tags  for all using (
  exists (select 1 from public.channels c where c.id = channel_id and c.user_id = auth.uid())
);

-- ============================================================
-- HELPER VIEWS
-- ============================================================

-- Channels enriched with tag IDs and watch stats (used by extension sync)
create or replace view public.channels_full as
select
  ch.*,
  coalesce(
    array_agg(ct.tag_id) filter (where ct.tag_id is not null),
    '{}'::uuid[]
  ) as tag_ids,
  coalesce(cs.watch_count, 0)           as watch_count,
  cs.last_watched_at,
  cs.last_seen_in_feed_at
from public.channels ch
left join public.channel_tags  ct on ct.channel_id = ch.id
left join public.channel_stats cs on cs.channel_id = ch.id
group by ch.id, cs.watch_count, cs.last_watched_at, cs.last_seen_in_feed_at;

-- Views inherit RLS from underlying tables automatically in Postgres 15+
-- but explicitly set the security_invoker to be safe
alter view public.channels_full set (security_invoker = true);
