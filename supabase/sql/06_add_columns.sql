-- ============================================================
-- PATCH: Adicionar colunas em falta na tabela matches
-- ============================================================

alter table public.matches
    add column if not exists confidence_score numeric(5,2),
    add column if not exists confidence_level text,
    add column if not exists predicted_winner_id bigint references public.players(id) on delete set null,
    add column if not exists player1_probability numeric(5,2),
    add column if not exists player2_probability numeric(5,2);
