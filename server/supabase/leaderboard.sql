-- ===========================================================================
--  Tiny Realm — durable GLOBAL leaderboard (Supabase Postgres)
--  Run this ONCE in the Supabase SQL editor (Dashboard → SQL → New query).
--
--  The relay server writes/reads this via the SERVICE-ROLE key (server-only).
--  RLS is enabled with NO public policies, so the table is unreachable with the
--  anon key — only the service-role relay (which bypasses RLS) can touch it.
-- ===========================================================================

create table if not exists public.leaderboard (
  addr  text primary key,                 -- wallet address = unique per-player key
  name  text not null default 'Anon',     -- display name (cosmetic)
  round integer not null,
  score integer not null,
  ts    bigint  not null                  -- ms epoch of this best run
);

-- fast top-N ordering (round desc, then score desc, then most recent)
create index if not exists leaderboard_rank_idx
  on public.leaderboard (round desc, score desc, ts desc);

-- lock the table down: RLS on, no policies → anon/public cannot read or write.
alter table public.leaderboard enable row level security;

-- Atomic, race-safe "keep this wallet's BEST run" upsert. Always refreshes the
-- display name; only bumps round/score/ts when the new run is strictly better.
create or replace function public.submit_score(
  p_addr text, p_name text, p_round integer, p_score integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.leaderboard (addr, name, round, score, ts)
  values (p_addr, p_name, p_round, p_score, (extract(epoch from now()) * 1000)::bigint)
  on conflict (addr) do update set
    name  = excluded.name,
    round = case when excluded.round > public.leaderboard.round
                  or (excluded.round = public.leaderboard.round and excluded.score > public.leaderboard.score)
                 then excluded.round else public.leaderboard.round end,
    score = case when excluded.round > public.leaderboard.round
                  or (excluded.round = public.leaderboard.round and excluded.score > public.leaderboard.score)
                 then excluded.score else public.leaderboard.score end,
    ts    = case when excluded.round > public.leaderboard.round
                  or (excluded.round = public.leaderboard.round and excluded.score > public.leaderboard.score)
                 then excluded.ts else public.leaderboard.ts end;
end;
$$;
