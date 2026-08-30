-- Update existing predictions with new formula

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
    use_elo boolean := false;
begin
    for match_record in
        select m.id, m.player1_id, m.player2_id, p1.ranking as p1_ranking, p2.ranking as p2_ranking, p1.elo_rating as p1_elo, p2.elo_rating as p2_elo
        from public.matches m
        left join public.players p1 on p1.id = m.player1_id
        left join public.players p2 on p2.id = m.player2_id
        where m.predicted_winner_id is not null
    loop
        if match_record.p1_elo is not null and match_record.p2_elo is not null and (match_record.p1_elo != 1500 or match_record.p2_elo != 1500) then
            use_elo := true;
        else
            use_elo := false;
        end if;

        if use_elo then
            elo_diff := match_record.p1_elo - match_record.p2_elo;
            p1_prob := 1.0 / (1.0 + power(10, -elo_diff / 400.0));
            p2_prob := 1.0 - p1_prob;
            p1_prob := round(p1_prob * 100, 2);
            p2_prob := round(p2_prob * 100, 2);
            conf_score := least(95, greatest(10, (abs(elo_diff) / 400.0) * 100 + 20));
            conf_score := round(conf_score, 0);
        else
            p1_ranking := coalesce(match_record.p1_ranking, 2000);
            p2_ranking := coalesce(match_record.p2_ranking, 2000);
            p1_prob := (1.0 / p1_ranking) / (1.0 / p1_ranking + 1.0 / p2_ranking);
            p2_prob = 1.0 - p1_prob;
            p1_prob := round(p1_prob * 100, 0);
            p2_prob := round(p2_prob * 100, 0);
            conf_score = least(95, greatest(10, (abs(p1_ranking - p2_ranking)::numeric / (p1_ranking + p2_ranking)::numeric) * 200 + 30));
            conf_score := round(conf_score, 0);
        end if;

        if abs(p1_prob - p2_prob) <= 10 then
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
            confidence_score = conf_score,
            confidence_level = conf_level,
            predicted_winner_id = predicted_winner
        where id = match_record.id;

        update public.match_predictions set
            player1_probability = p1_prob,
            player2_probability = p2_prob,
            confidence_score = conf_score,
            confidence_level = conf_level,
            predicted_winner_id = predicted_winner
        where match_id = match_record.id;
    end loop;
end;
$$;
