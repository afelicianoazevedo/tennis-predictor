-- ============================================================
-- PATCH: Adicionar unique constraint em match_predictions.match_id
-- ============================================================

-- Remover duplicados se existirem
delete from public.match_predictions
where id not in (
    select min(id)
    from public.match_predictions
    group by match_id
);

-- Adicionar unique constraint
alter table public.match_predictions
    add constraint match_predictions_match_id_key unique (match_id);
