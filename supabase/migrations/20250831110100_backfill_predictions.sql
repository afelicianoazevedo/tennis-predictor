-- Backfill existing predictions with new ranking-first formula

do $$
declare
    match_record record;
    p1_elo numeric;
    p2_elo numeric;
    p1_ranking integer;
    p2_ranking integer;
    elo_diff numeric;
    p1_prob numeric;
    p2_prob numeric;
    conf_score numeric;
    conf_level text;
    predicted_winner bigint;
    p1_elo_prob numeric;
    p2_elo_prob numeric;
    elo_agrees boolean;
begin
    for match_record in
        select m.id, m.player1_id, m.player2_id, p1.ranking as p1_ranking, p2.ranking as p2_ranking, p1.elo_rating as p1_elo, p2.elo_rating as p2_elo
        from public.matches m
        left join public.players p1 on p1.id = m.player1_id
        left join public.players p2 on p2.id = m.player2_id
        where m.predicted_winner_id is not null
          and m.category IS DISTINCT FROM 'D'
    loop
        p1_ranking := coalesce(match_record.p1_ranking, 2000);
        p2_ranking := coalesce(match_record.p2_ranking, 2000);

        p1_prob := (1.0 / p1_ranking) / (1.0 / p1_ranking + 1.0 / p2_ranking) * 100;
        p2_prob := 100.0 - p1_prob;

        p1_elo := coalesce(match_record.p1_elo, 1500);
        p2_elo := coalesce(match_record.p2_elo, 1500);
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

        p1_prob := round(p1_prob, 2);
        p2_prob := round(100.0 - p1_prob, 2);

        if p1_prob <= 57 and p2_prob <= 57 then
            predicted_winner := null;
            conf_level := 'incerto';
        else
            if p1_prob > p2_prob then
                predicted_winner := match_record.player1_id;
            elsif p2_prob > p1_prob then
                predicted_winner := match_record.player2_id;
            else
                predicted_winner := null;
            end if;

            conf_score := least(95, greatest(10,
                (abs(p1_ranking - p2_ranking)::numeric / (p1_ranking + p2_ranking)::numeric) * 200 + 30
            ));

            if elo_agrees then
                conf_score := least(95, conf_score + 5);
            elsif p1_elo is not null and p2_elo is not null and (p1_elo != 1500 or p2_elo != 1500) then
                conf_score := greatest(10, conf_score - 5);
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
        end if;

        update public.matches set
            player1_probability = p1_prob,
            player2_probability = p2_prob,
            confidence_score = nullif(conf_score, null),
            confidence_level = conf_level,
            predicted_winner_id = predicted_winner
        where id = match_record.id;

        update public.match_predictions set
            player1_probability = p1_prob,
            player2_probability = p2_prob,
            confidence_score = nullif(conf_score, null),
            confidence_level = conf_level,
            predicted_winner_id = predicted_winner
        where match_id = match_record.id;
    end loop;
end;
$$;
