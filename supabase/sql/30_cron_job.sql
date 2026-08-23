-- ============================================================
-- TENNIS PREDICTOR - PHASE 17: ODDS SYNC INFRASTRUCTURE
-- ============================================================

-- NOTA: O Supabase não suporta pg_cron no tier gratuito.
-- O cron job deve ser configurado externamente via:
-- 1. GitHub Actions (recomendado)
-- 2. Vercel Cron Jobs
-- 3. Netlify Scheduled Functions
-- 4. Servidor externo com cron tradicional
--
-- A Edge Function fetch-odds está deployada e pronta.
-- Chame GET /functions/v1/fetch-odds/cron periodicamente.

-- ============================================================
-- 1. VERIFICAR SE A EXTENSÃO pg_cron ESTÁ DISPONÍVEL
-- ============================================================

-- Se pg_cron estiver disponível, use:
-- SELECT cron.schedule('fetch-odds-cron', '0 * * * *', $$
--     SELECT net.http_post(
--         'https://ywmrxvurnxgnmpcjnisi.supabase.co/functions/v1/fetch-odds/cron',
--         '{}',
--         '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3bXJ4dnVybnhnbm1wY2puaXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MDA2MjIsImV4cCI6MjEwMjk3NjYyMn0.TXp8PMNWoKekdmkByhvtJodS7OLmMeRGiBp1WomOCA0"}'
--     );
--     $$
-- );

-- ============================================================
-- 2. TESTAR A FUNÇÃO DE SYNC
-- ============================================================

-- Teste manual:
-- SELECT public.regenerate_predictions_with_odds(24);

-- ============================================================
-- 3. LIMPAR ODDS ANTIGAS (OPCIONAL)
-- ============================================================

-- Limpar odds com mais de 30 dias:
-- SELECT public.cleanup_old_odds(30);
