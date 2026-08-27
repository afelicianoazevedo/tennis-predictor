-- Remove previsões de jogos de duplos (D)
DELETE FROM public.match_predictions
WHERE match_id IN (SELECT id FROM public.matches WHERE category = 'D');

-- Limpa campos de previsão nos jogos D
UPDATE public.matches
SET confidence_score = NULL,
    confidence_level = NULL,
    predicted_winner_id = NULL,
    player1_probability = NULL,
    player2_probability = NULL
WHERE category = 'D';
