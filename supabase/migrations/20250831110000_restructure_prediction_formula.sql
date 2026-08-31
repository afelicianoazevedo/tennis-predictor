-- Restructure prediction formula: ranking-first, ELO/odds only adjust if decisive
-- Skip predictions without clear favorite (>57%)
-- Confidence based on ranking difference with ELO/odds agreement adjustment

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
    elo_agrees boolean;
    odds_agrees boolean;
begin
    select m.player1_id, m.player2_id, p1.ranking, p2.ranking, p1.ranking_points, p2.ranking_points
    into p1_id, p2_id, p1_ranking, p2_ranking, p1_points, p2_points
    from public.matches m
    left join public.players p1 on p1.id = m.player1_id
    left join public.players p2 on p2.id = m.player2_id
    where m.id = p_match_id;

    if p1_id is null or p2_id is null then
        return query select null::numeric, null::numeric, null::numeric, null::text, null::bigint;
        return;
    end if;

    if p1_ranking is null then p1_ranking = 2000; end if;
    if p2_ranking is null then p2_ranking = 2000; end if;

    p1_rank_prob := (1.0 / p1_ranking) / (1.0 / p1_ranking + 1.0 / p2_ranking);
    p2_rank_prob := 1.0 - p1_rank_prob;

    p1_prob := p1_rank_prob * 100;
    p2_prob := p2_rank_prob * 100;

    select coalesce(p1.elo_rating, 1500) into p1_elo from public.players p1 where p1.id = p1_id;
    select coalesce(p2.elo_rating, 1500) into p2_elo from public.players p2 where p2.id = p2_id;

    elo_agrees := false;
    if p1_elo is not null and p2_elo is not null and (p1_elo != 1500 or p2_elo != 1500) then
        elo_diff := p1_elo - p2_elo;
        p1_elo_prob := 1.0 / (1.0 + power(10, -elo_diff / 400.0)) * 100;
        p2_elo_prob := 100.0 - p1_elo_prob;

        if abs(p1_elo_prob - 50) > 7 then
            elo_agrees := (p1_elo > p2_elo and p1_prob > p2_prob) or (p2_elo > p1_elo and p2_prob > p1_prob);
            p1_prob := p1_prob * 0.7 + p1_elo_prob * 0.3;
            p2_prob := p2_prob * 0.7 + p2_elo_prob * 0.3;
        end if;
    end if;

    select o.player1_odd, o.player2_odd into p1_odd, p2_odd
    from public.odds o
    where o.match_id = p_match_id
    limit 1;

    has_odds := p1_odd IS NOT NULL AND p2_odd IS NOT NULL AND p1_odd > 0 AND p2_odd > 0;

    odds_agrees := false;
    if has_odds then
        p1_odds_prob := (1.0 / p1_odd) / ((1.0 / p1_odd) + (1.0 / p2_odd)) * 100;
        p2_odds_prob := 100.0 - p1_odds_prob;

        if abs(p1_odds_prob - 50) > 7 then
            odds_agrees := (p1_odds_prob > p2_odds_prob and p1_prob > p2_prob) or (p2_odds_prob > p1_odds_prob and p2_prob > p1_prob);
            p1_prob := p1_prob * 0.7 + p1_odds_prob * 0.3;
            p2_prob := p2_prob * 0.7 + p2_odds_prob * 0.3;
        end if;
    end if;

    p1_prob := round(p1_prob, 2);
    p2_prob := round(100.0 - p1_prob, 2);

    if p1_prob <= 57 and p2_prob <= 57 then
        return query select p1_prob, p2_prob, null::numeric, null::text, null::bigint;
        return;
    end if;

    conf_score := least(95, greatest(10,
        (abs(p1_ranking - p2_ranking)::numeric / (p1_ranking + p2_ranking)::numeric) * 200 + 30
    ));

    if elo_agrees then
        conf_score := least(95, conf_score + 5);
    elsif p1_elo is not null and p2_elo is not null and (p1_elo != 1500 or p2_elo != 1500) then
        conf_score := greatest(10, conf_score - 5);
    end if;

    if odds_agrees then
        conf_score := least(95, conf_score + 3);
    elsif has_odds then
        conf_score := greatest(10, conf_score - 3);
    end if;

    conf_score := round(conf_score, 0);

    if conf_score < 50 then
        conf_level := 'incerto';
    elsif conf_score < 60 then
        conf_level := 'perigoso';
    elsif conf_score < 70 then
        conf_level := 'tendencia';
    else
        conf_level := 'forte';
    end if;

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
