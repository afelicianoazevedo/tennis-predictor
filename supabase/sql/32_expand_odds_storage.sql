-- ============================================================
-- TENNIS PREDICTOR - EXPAND ODDS STORAGE
-- ============================================================

-- Adicionar colunas para armazenar odds de jogos que não existem na BD
ALTER TABLE public.odds
    ADD COLUMN IF NOT EXISTS player1_name text,
    ADD COLUMN IF NOT EXISTS player2_name text,
    ADD COLUMN IF NOT EXISTS sport_key text,
    ADD COLUMN IF NOT EXISTS commence_time timestamptz;

-- Índices para busca por nome/date
CREATE INDEX IF NOT EXISTS idx_odds_player1_name ON public.odds(player1_name);
CREATE INDEX IF NOT EXISTS idx_odds_player2_name ON public.odds(player2_name);
CREATE INDEX IF NOT EXISTS idx_odds_commence_time ON public.odds(commence_time);
CREATE INDEX IF NOT EXISTS idx_odds_sport_key ON public.odds(sport_key);
