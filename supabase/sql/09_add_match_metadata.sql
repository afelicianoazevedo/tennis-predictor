-- ============================================================
-- PATCH: Adicionar colunas de metadados do SportScore
-- ============================================================

alter table public.matches
    add column if not exists sportscore_url text,
    add column if not exists home_logo text,
    add column if not exists away_logo text,
    add column if not exists competition_logo text,
    add column if not exists status_text text;

create unique index if not exists idx_matches_sportscore_url
    on public.matches(sportscore_url)
    where sportscore_url is not null;
