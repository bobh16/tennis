-- ============================================================
-- Court Sense — initial Supabase schema
-- Paste this whole file into the Supabase SQL Editor and click Run.
-- ============================================================

-- Club roster (members). We use the app's own ids as the primary key
-- so syncing is a straight match, no id translation needed.
create table if not exists members (
  id          text primary key,
  name        text not null,
  rating      numeric not null default 3.5,
  gender      text,                         -- 'f', 'm', or null
  reliability numeric not null default 0,
  games       int  not null default 0,
  wins        int  not null default 0,
  losses      int  not null default 0,
  updated_at  timestamptz not null default now()
);

-- Recorded open-play match results (central history + rating tally).
create table if not exists play_results (
  id         text primary key,
  played_on  date,
  team_a     text[] not null,               -- member ids on team A
  team_b     text[] not null,               -- member ids on team B
  score_a    int,
  score_b    int,
  created_at timestamptz not null default now()
);

-- Tournaments. Divisions, teams and matches are stored inside `data` (JSON),
-- so the app's nested structure maps straight across for a first sync.
create table if not exists tournaments (
  id         text primary key,
  name       text not null,
  type       text not null default 'roundrobin',   -- or 'elimination'
  courts     int  not null default 2,
  start_date date,
  end_date   date,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Access — TEMPORARY, OPEN. Turns on row-level security but lets the
-- public anon key read/write everything. Fine for early testing with a
-- single organizer; we replace this with real logins before live use.
-- ------------------------------------------------------------
alter table members      enable row level security;
alter table play_results enable row level security;
alter table tournaments  enable row level security;

drop policy if exists "anon all members"      on members;
drop policy if exists "anon all play_results" on play_results;
drop policy if exists "anon all tournaments"  on tournaments;

create policy "anon all members"      on members      for all to anon using (true) with check (true);
create policy "anon all play_results" on play_results for all to anon using (true) with check (true);
create policy "anon all tournaments"  on tournaments  for all to anon using (true) with check (true);
