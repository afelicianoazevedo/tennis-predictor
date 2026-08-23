-- ============================================================
-- ADICIONAR COLUNA DE SETS À TABELA MATCHES
-- ============================================================

ALTER TABLE public.matches
    ADD COLUMN IF NOT EXISTS sets text;

COMMENT ON COLUMN public.matches.sets IS 'Resultado dos sets, ex: 6-4, 7-5, 6-3';
