-- ============================================================
-- AUTOMAÇÃO - Alternativa sem pg_cron
-- Usar serviços externos gratuitos para chamar a Edge Function
-- ============================================================

-- ============================================================
-- 1. FUNÇÃO: Registrar execução de sync (para monitorização)
-- ============================================================

create or replace function public.log_sync_execution(
    p_sync_type text,
    p_status text,
    p_matches_processed integer default 0,
    p_requests_consumed integer default 0,
    p_error_message text default null
)
returns void
language sql
as $$
    insert into public.sync_schedule (
        scheduled_date, sync_type, scheduled_at, status,
        matches_processed, requests_consumed, error_message,
        started_at, completed_at
    ) values (
        current_date, p_sync_type, now(), p_status,
        p_matches_processed, p_requests_consumed, p_error_message,
        now(), now()
    );
$$;


-- ============================================================
-- 2. FUNÇÃO: Obter URL da Edge Function
-- ============================================================

create or replace function public.get_edge_function_url()
returns text
language sql
as $$
    select 'https://ywmrxvurnxgnmpcjnisi.supabase.co/functions/v1/update-tennis-data';
$$;


-- ============================================================
-- INSTRUÇÕES PARA AUTOMAÇÃO
-- ============================================================
--
-- Como o pg_cron não está disponível, usar um destes serviços:
--
-- OPÇÃO 1: cron-job.org (gratuito)
-- 1. Criar conta em https://cron-job.org
-- 2. Criar jobs com estes horários:
--
--    Nome: tennis-morning-sync
--    Horário: 0 8 * * * (todos os dias às 08:00)
--    URL: https://ywmrxvurnxgnmpcjnisi.supabase.co/functions/v1/update-tennis-data?mode=morning
--    Headers: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bXJ4dnVybnhnbm1wY2puaXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MDA2MjIsImV4cCI6MjEwMjk3NjYyMn0.TXp8PMNWoKekdmkByhvtJodS7OLmMeRGiBp1WomOCA0
--
--    Nome: tennis-live-poll
--    Horário: */15 10-23 * * * (cada 15 min, 10h-23h)
--    URL: https://ywmrxvurnxgnmpcjnisi.supabase.co/functions/v1/update-tennis-data?mode=live
--    Headers: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bXJ4dnVybnhnbm1wY2puaXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MDA2MjIsImV4cCI6MjEwMjk3NjYyMn0.TXp8PMNWoKekdmkByhvtJodS7OLmMeRGiBp1WomOCA0
--
--    Nome: tennis-post-game
--    Horário: 0 0 * * * (meia-noite)
--    URL: https://ywmrxvurnxgnmpcjnisi.supabase.co/functions/v1/update-tennis-data?mode=post_game
--    Headers: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bXJ4dnVybnhnbm1wY2puaXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MDA2MjIsImV4cCI6MjEwMjk3NjYyMn0.TXp8PMNWoKekdmkByhvtJodS7OLmMeRGiBp1WomOCA0
--
-- OPÇÃO 2: GitHub Actions (gratuito)
-- Criar .github/workflows/tennis-sync.yml (ver ficheiro de exemplo)
--
-- OPÇÃO 3: Supabase Dashboard (se disponível)
-- Database > Scheduled Functions > Create Function
-- ============================================================
