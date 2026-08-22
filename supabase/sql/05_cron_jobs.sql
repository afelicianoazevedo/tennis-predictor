-- ============================================================
-- AUTOMAÇÃO (CRON JOBS)
-- ============================================================

-- ============================================================
-- 1. EDGE FUNCTION para sincronização (já existe)
-- Os cron jobs vão chamar a Edge Function via HTTP
-- ============================================================

-- ============================================================
-- 2. CRON: Morning Sync (todos os dias às 08:00)
-- ============================================================

select cron.schedule(
    'morning-sync',
    '0 8 * * *',
    $$
    select net.http_get(
        url := 'https://ywmrxvurnxgnmpcjnisi.supabase.co/functions/v1/update-tennis-data?mode=morning',
        headers := '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bXJ4dnVybnhnbm1wY2puaXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MDA2MjIsImV4cCI6MjEwMjk3NjYyMn0.TXp8PMNWoKekdmkByhvtJodS7OLmMeRGiBp1WomOCA0"}'
    )
    $$
);

-- ============================================================
-- 3. CRON: Pre-Game Sync (dias de jogo às 13:00)
-- ============================================================

select cron.schedule(
    'pre-game-sync',
    '0 13 * * *',
    $$
    select net.http_get(
        url := 'https://ywmrxvurnxgnmpcjnisi.supabase.co/functions/v1/update-tennis-data?mode=pre_game',
        headers := '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bXJ4dnVybnhnbm1wY2puaXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MDA2MjIsImV4cCI6MjEwMjk3NjYyMn0.TXp8PMNWoKekdmkByhvtJodS7OLmMeRGiBp1WomOCA0"}'
    )
    $$
);

-- ============================================================
-- 4. CRON: Live Poll (a cada 15 min durante horário de jogos)
-- ============================================================

select cron.schedule(
    'live-poll',
    '*/15 10-23 * * *',
    $$
    select net.http_get(
        url := 'https://ywmrxvurnxgnmpcjnisi.supabase.co/functions/v1/update-tennis-data?mode=live',
        headers := '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bXJ4dnVybnhnbm1wY2puaXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MDA2MjIsImV4cCI6MjEwMjk3NjYyMn0.TXp8PMNWoKekdmkByhvtJodS7OLmMeRGiBp1WomOCA0"}'
    )
    $$
);

-- ============================================================
-- 5. CRON: Post-Game Sync (após último jogo)
-- ============================================================

select cron.schedule(
    'post-game-sync',
    '0 0 * * *',
    $$
    select net.http_get(
        url := 'https://ywmrxvurnxgnmpcjnisi.supabase.co/functions/v1/update-tennis-data?mode=post_game',
        headers := '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bXJ4dnVybnhnbm1wY2puaXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MDA2MjIsImV4cCI6MjEwMjk3NjYyMn0.TXp8PMNWoKekdmkByhvtJodS7OLmMeRGiBp1WomOCA0"}'
    )
    $$
);


-- ============================================================
-- 6. CRON: Generate Predictions (após morning sync)
-- ============================================================

select cron.schedule(
    'generate-predictions',
    '15 8 * * *',
    $$
    select public.generate_all_predictions()
    $$
);


-- ============================================================
-- VER CRON JOBS
-- ============================================================

select * from cron.job;


-- ============================================================
-- REMOVER CRON JOBS (se necessário)
-- ============================================================

-- select cron.unschedule('morning-sync');
-- select cron.unschedule('pre-game-sync');
-- select cron.unschedule('live-poll');
-- select cron.unschedule('post-game-sync');
-- select cron.unschedule('generate-predictions');
