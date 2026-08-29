-- Recreate fixed trigger and backfill was_correct for existing completed matches

-- Recreate trigger with correct function
create or replace function public.check_prediction_result()
returns trigger
language plpgsql
as $$
begin
    if new.winner_id is not null then
        update public.match_predictions set
            was_correct = (predicted_winner_id = new.winner_id),
            result = case when predicted_winner_id = new.winner_id then 'correct' else 'incorrect' end
        where match_id = new.id;
    end if;
    return new;
end;
$$;

create trigger trg_check_prediction
    after update of winner_id on public.matches
    for each row
    when (new.winner_id is not null)
    execute function public.check_prediction_result();

-- Backfill was_correct for all completed matches with predictions
UPDATE public.match_predictions mp
SET 
    was_correct = (mp.predicted_winner_id = m.winner_id),
    result = case when mp.predicted_winner_id = m.winner_id then 'correct' else 'incorrect' end
FROM public.matches m
WHERE mp.match_id = m.id
  AND m.status = 'completed'
  AND m.winner_id IS NOT NULL
  AND mp.was_correct IS NULL;
