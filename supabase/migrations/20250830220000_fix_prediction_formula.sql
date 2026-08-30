-- Fix prediction formula: use ranking even when only one player has ranking
-- and skip predictions for close matches (<= 10 points difference)

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
    p1_prob numeric;
    p2_prob numeric;
    conf_score numeric;
    conf_level text;
    winner_id bigint;
    p1_id bigint;
    p2_id bigint;
    use_elo boolean := false;
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

    IF p1_elo IS NOT NULL AND p2_elo IS NOT NULL AND (p1_elo != 1500 OR p2_elo != 1500) THEN
        use_elo := true;
    END IF;

    -- Se não há dados suficientes
    if not use_elo and p1_ranking is null and p2_ranking is null then
        return query select 50.0::numeric, 50.0::numeric, 10.0::numeric, 'incerto'::text, null::bigint;
        return;
    end if;

    IF use_elo THEN
        -- Calcular probabilidades baseadas no Elo
        elo_diff := p1_elo - p2_elo;
        p1_prob := 1.0 / (1.0 + power(10, -elo_diff / 400.0));
        p2_prob := 1.0 - p1_prob;

        -- Converter para percentagem
        p1_prob := round(p1_prob * 100, 2);
        p2_prob := round(p2_prob * 100, 2);

        -- Calcular confiança baseada na diferença de Elo
        conf_score := least(95, greatest(10, (abs(elo_diff) / 400.0) * 100 + 20));
        conf_score := round(conf_score, 0);
    ELSE
        -- Fallback para ranking se Elo não disponível
        if p1_ranking is null then p1_ranking = 2000; end if;
        if p2_ranking is null then p2_ranking = 2000; end if;

        p1_prob = (1.0 / p1_ranking) / (1.0 / p1_ranking + 1.0 / p2_ranking);
        p2_prob = 1.0 - p1_prob;

        p1_prob = round(p1_prob * 100, 0);
        p2_prob = round(p2_prob * 100, 0);

        conf_score = least(95, greatest(10, (abs(p1_ranking - p2_ranking)::numeric / (p1_ranking + p2_ranking)::numeric) * 200 + 30));
        conf_score = round(conf_score, 0);
    END IF;

    -- Skip prediction if match is too close (<= 10 points difference)
    if abs(p1_prob - p2_prob) <= 10 then
        return query select p1_prob, p2_prob, conf_score, 'incerto'::text, null::bigint;
        return;
    end if;

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
