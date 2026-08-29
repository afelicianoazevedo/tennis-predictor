-- Populate winner_id for completed matches based on sets data

UPDATE public.matches
SET winner_id = CASE
    WHEN (sets::jsonb->0)::int > (sets::jsonb->1)::int THEN player1_id
    WHEN (sets::jsonb->1)::int > (sets::jsonb->0)::int THEN player2_id
    ELSE winner_id
END
WHERE status = 'completed'
  AND winner_id IS NULL
  AND sets IS NOT NULL
  AND sets ~ '^\[\d+,\d+\]$';

-- Log the update
DO $$
DECLARE
    updated_count integer;
BEGIN
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RAISE NOTICE 'Updated winner_id for % completed matches', updated_count;
END $$;
