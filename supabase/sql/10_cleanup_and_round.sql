-- ============================================================
-- CLEANUP: Remover jogos terminados com score 0-0 (dados errados)
-- ============================================================

delete from public.matches
where status = 'completed'
  and score = '0-0'
  and scheduled_at < now();

-- ============================================================
-- PATCH: Arredondar probabilidades para 0 casas decimais
-- ============================================================

update public.match_predictions
set
    player1_probability = round(player1_probability),
    player2_probability = round(player2_probability),
    confidence_score = round(confidence_score)
where player1_probability is not null
  or player2_probability is not null;

update public.matches
set
    player1_probability = round(player1_probability),
    player2_probability = round(player2_probability),
    confidence_score = round(confidence_score)
where player1_probability is not null
  or player2_probability is not null;
