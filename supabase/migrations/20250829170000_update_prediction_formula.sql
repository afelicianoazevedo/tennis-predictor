-- Update prediction formula to combine ELO, ranking, and odds

create or replace function public.calculate_match_prediction(p_match_id bigint)
returns table (
    player1_probability numeric,
    player2_probability numeric,
    confidence_score numeric,
    confidence_level text,
    predicted_winner_id bigint
)
language plpgsql
as $$
declare
    p1_elo numeric;
    p2_elo numeric;
    p1_ranking integer;
    p2_ranking integer;
    p1_points numeric;
    p2_points numeric;
    elo_diff numeric;
    p1_elo_prob numeric;
    p2_elo_prob numeric;
    p1_rank_prob numeric;
    p2_rank_prob numeric;
    p1_odds_prob numeric;
    p2_odds_prob numeric;
    p1_odd numeric;
    p2_odd numeric;
    has_odds boolean;
    p1_prob numeric;
    p2_prob numeric;
    conf_score numeric;
    conf_level text;
    winner_id bigint;
    p1_id bigint;
    p2_id bigint;
    elo_agreement numeric;
    rank_agreement numeric;
    odds_agreement numeric;
    avg_agreement numeric;
begin
    -- Obter dados dos jogadores
    select m.player1_id, m.player2_id, p1.ranking, p2.ranking, p1.ranking_points, p2.ranking_points
    into p1_id, p2_id, p1_ranking, p2_ranking, p1_points, p2_points
    from public.matches m
    left join public.players p1 on p1.id = m.player1_id
    left join public.players p2 on p2.id = m.player2_id
    where m.id = p_match_id;

    -- Tentar usar Elo se disponível
    select coalesce(p1.elo_rating, 1500) into p1_elo from public.players p1 where p1.id = p1_id;
    select coalesce(p2.elo_rating, 1500) into p2_elo from public.players p2 where p2.id = p2_id;

    -- Calcular probabilidade baseada no Elo
    elo_diff := p1_elo - p2_elo;
    p1_elo_prob := 1.0 / (1.0 + power(10, -elo_diff / 400.0));
    p2_elo_prob := 1.0 - p1_elo_prob;

    -- Calcular probabilidade baseada no ranking
    if p1_ranking is null then p1_ranking = 2000; end if;
    if p2_ranking is null then p2_ranking = 2000; end if;
    p1_rank_prob := (1.0 / p1_ranking) / (1.0 / p1_ranking + 1.0 / p2_ranking);
    p2_rank_prob := 1.0 - p1_rank_prob;

    -- Tentar obter odds
    select o.player1_odd, o.player2_odd into p1_odd, p2_odd
    from public.odds o
    where o.match_id = p_match_id
    limit 1;

    has_odds := p1_odd IS NOT NULL AND p2_odd IS NOT NULL AND p1_odd > 0 AND p2_odd > 0;

    if has_odds then
        p1_odds_prob := (1.0 / p1_odd) / ((1.0 / p1_odd) + (1.0 / p2_odd));
        p2_odds_prob := 1.0 - p1_odds_prob;
    end if;

    -- Combinar probabilidades com pesos
    if has_odds then
        p1_prob := 0.5 * p1_elo_prob + 0.3 * p1_rank_prob + 0.2 * p1_odds_prob;
        p2_prob := 0.5 * p2_elo_prob + 0.3 * p2_rank_prob + 0.2 * p2_odds_prob;
    else
        p1_prob := 0.6 * p1_elo_prob + 0.4 * p1_rank_prob;
        p2_prob := 0.6 * p2_elo_prob + 0.4 * p2_rank_prob;
    end if;

    -- Normalizar para percentagem
    p1_prob := round(p1_prob * 100, 2);
    p2_prob := round(p2_prob * 100, 2);

    -- Calcular acordo entre fatores
    elo_agreement := greatest(p1_elo_prob, p2_elo_prob) - least(p1_elo_prob, p2_elo_prob);
    rank_agreement := greatest(p1_rank_prob, p2_rank_prob) - least(p1_rank_prob, p2_rank_prob);
    
    if has_odds then
        odds_agreement := greatest(p1_odds_prob, p2_odds_prob) - least(p1_odds_prob, p2_odds_prob);
        avg_agreement := (elo_agreement + rank_agreement + odds_agreement) / 3.0;
    else
        avg_agreement := (elo_agreement + rank_agreement) / 2.0;
    end if;

    -- Calcular confiança baseada na diferença de probabilidade e acordo entre fatores
    if has_odds then
        conf_score := least(95, greatest(10, 
            (abs(p1_prob - p2_prob) / 100.0) * 60 + 
            avg_agreement * 30 +
            10
        ));
    else
        conf_score := least(95, greatest(10, 
            (abs(p1_prob - p2_prob) / 100.0) * 60 + 
            avg_agreement * 30
        ));
    end if;
    conf_score := round(conf_score, 0);

    -- Determinar nível de confiança
    if conf_score < 50 then
        conf_level := 'incerto';
    elsif conf_score < 60 then
        conf_level := 'perigoso';
    elsif conf_score < 70 then
        conf_level := 'tendencia';
    else
        conf_level := 'forte';
    end if;

    -- Determinar vencedor previsto
    if p1_prob > p2_prob then
        winner_id := p1_id;
    elsif p2_prob > p1_prob then
        winner_id := p2_id;
    else
        winner_id := null;
    end if;

    return query select p1_prob, p2_prob, conf_score, conf_level, winner_id;
end;
$$;
