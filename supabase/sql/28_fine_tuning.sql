-- ============================================================
-- TENNIS PREDICTOR - MODEL FINE-TUNING (Phase 15)
-- ============================================================

-- Problema identificado:
-- 1. Todos os jogos upcoming/live tinham predicted_winner_id = NULL
-- 2. Probabilidades sempre 50/50 quando não havia dados suficientes
-- 3. Frontend mostrava 50% sempre para o jogador 1

-- Soluções implementadas:
-- 1. Tiebreaker no calculate_full_prediction quando advantage_diff = 0
-- 2. Atualização do frontend para mostrar probabilidades de ambos os jogadores

-- ============================================================
-- 1. TIEBREAKER NO calculate_full_prediction
-- ============================================================

-- Quando todos os fatores são iguais (50/50 ou NULL):
-- 1. Usar ranking_points como desempate (+2 ou -2 na vantagem)
-- 2. Se ranking_points forem iguais, usar ID do jogador como desempate final

-- Isto garante que:
-- - Nunca há exatamente 50/50
-- - O vencedor previsto é sempre definido
-- - O desempate é determinístico e reproduzível

-- ============================================================
-- 2. ATUALIZAÇÕES NO FRONTEND
-- ============================================================

-- Modal e match cards agora mostram:
-- - Probabilidade do jogador 1 (sempre)
-- - Probabilidade do jogador 2 (sempre)
-- - Em vez de apenas mostrar o favorito

-- Isto resolve o problema visual de "sempre 50% para o jogador 1"
