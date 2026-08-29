-- Drop broken trigger before updating winner_id

DROP TRIGGER IF EXISTS trg_check_prediction ON public.matches;
