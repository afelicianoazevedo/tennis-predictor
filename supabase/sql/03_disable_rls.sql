-- ============================================================
-- URGENTE: Desativar RLS para permitir leitura pública
-- ============================================================

ALTER TABLE public.matches DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.players DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournaments DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_predictions DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.odds DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_usage DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_requests DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_config DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_schedule DISABLE ROW LEVEL SECURITY;
