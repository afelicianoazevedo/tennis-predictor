-- ============================================================
-- TENNIS PREDICTOR - MATCH SCORE + PROBABILITY
-- ============================================================

-- ============================================================
-- 1. CONFIGURAÇÃO DO MODELO
-- ============================================================

create or replace function public.get_model_weights()
returns table (
    ranking_weight numeric,
    strength_weight numeric,
    form_weight numeric,
    surface_weight numeric,
    serve_weight numeric,
    return_weight numeric,
    h2h_weight numeric,
    market_weight numeric,
    context_weight numeric
)
language plpgsql
as $$
begin
    ranking_weight := 0.49;
    strength_weight := 0.10;
    form_weight := 0.10;
    surface_weight := 0.08;
    serve_weight := 0.05;
    return_weight := 0.04;
    h2h_weight := 0.05;
    market_weight := 0.04;
    context_weight := 0.05;
    RETURN NEXT;
END;
$$;


-- ============================================================
-- 2. FUNÇÃO: Normalizar Elo para score 0-100
-- ============================================================

create or replace function public.normalize_elo_score(
    p_elo numeric,
    p_opponent_elo numeric
)
returns numeric
language plpgsql
as $$
declare
    elo_diff numeric;
    normalized_score numeric;
begin
    IF p_elo IS NULL OR p_opponent_elo IS NULL THEN
        RETURN NULL;
    END IF;

    elo_diff := p_elo - p_opponent_elo;

    normalized_score := 50 + (elo_diff / 400.0) * 50;
    normalized_score := greatest(0, least(100, normalized_score));

    RETURN round(normalized_score, 2);
end;
$$;


-- ============================================================
-- 3. FUNÇÃO: Calcular match score completo
-- ============================================================

create or replace function public.calculate_match_score(
    p_player1_id bigint,
    p_player2_id bigint,
    p_surface text,
    p_before_date timestamptz,
    p_match_id bigint default NULL
)
returns table (
    player1_strength_score numeric,
    player2_strength_score numeric,
    player1_form_score numeric,
    player2_form_score numeric,
    player1_surface_score numeric,
    player2_surface_score numeric,
    player1_serve_score numeric,
    player2_serve_score numeric,
    player1_return_score numeric,
    player2_return_score numeric,
    player1_h2h_score numeric,
    player2_h2h_score numeric,
    player1_market_score numeric,
    player2_market_score numeric,
    player1_context_score numeric,
    player2_context_score numeric,
    player1_ranking_score numeric,
    player2_ranking_score numeric,
    agreement_score numeric,
    data_quality_score numeric
)
language plpgsql
as $$
declare
    p1_elo numeric;
    p2_elo numeric;
    p1_surface_elo numeric;
    p2_surface_elo numeric;
    form_record1 record;
    form_record2 record;
    surface_record1 record;
    surface_record2 record;
    serve_record1 record;
    serve_record2 record;
    return_record1 record;
    return_record2 record;
    h2h_record record;
    market_record record;
    context_record1 record;
    context_record2 record;
    weights record;
    p1_ranking numeric;
    p2_ranking numeric;
    p1_ranking_score numeric;
    p2_ranking_score numeric;
    p1_weighted_sum numeric := 0;
    p2_weighted_sum numeric := 0;
    total_weight numeric := 0;
    agreement_count integer := 0;
    agreement_total integer := 0;
    quality_score numeric := 0;
    quality_count integer := 0;
    p1_prob numeric;
    p2_prob numeric;
begin
    -- Obter Elo pré-jogo
    IF p_before_date IS NOT NULL THEN
        SELECT public.get_player_elo_before(p_player1_id, p_before_date) INTO p1_elo;
        SELECT public.get_player_elo_before(p_player2_id, p_before_date) INTO p2_elo;
    ELSE
        SELECT coalesce(elo_rating, 1500) INTO p1_elo FROM public.players WHERE id = p_player1_id;
        SELECT coalesce(elo_rating, 1500) INTO p2_elo FROM public.players WHERE id = p_player2_id;
    END IF;

    IF p1_elo IS NULL THEN p1_elo := 1500; END IF;
    IF p2_elo IS NULL THEN p2_elo := 1500; END IF;

    -- Obter Surface Elo pré-jogo
    IF p_surface IS NOT NULL AND p_before_date IS NOT NULL THEN
        SELECT coalesce(pp.elo_rating, p1_elo) INTO p1_surface_elo
        FROM public.player_performance pp
        WHERE pp.player_id = p_player1_id 
          AND pp.surface = p_surface
          AND pp.updated_at IS NOT NULL
          AND pp.updated_at < p_before_date
        ORDER BY pp.updated_at DESC LIMIT 1;

        SELECT coalesce(pp.elo_rating, p2_elo) INTO p2_surface_elo
        FROM public.player_performance pp
        WHERE pp.player_id = p_player2_id 
          AND pp.surface = p_surface
          AND pp.updated_at IS NOT NULL
          AND pp.updated_at < p_before_date
        ORDER BY pp.updated_at DESC LIMIT 1;
    ELSIF p_surface IS NOT NULL THEN
        SELECT coalesce(pp.elo_rating, p1_elo) INTO p1_surface_elo
        FROM public.player_performance pp
        WHERE pp.player_id = p_player1_id AND pp.surface = p_surface
        ORDER BY pp.period_end DESC LIMIT 1;

        SELECT coalesce(pp.elo_rating, p2_elo) INTO p2_surface_elo
        FROM public.player_performance pp
        WHERE pp.player_id = p_player2_id AND pp.surface = p_surface
        ORDER BY pp.period_end DESC LIMIT 1;
    ELSE
        p1_surface_elo := p1_elo;
        p2_surface_elo := p2_elo;
    END IF;

    -- Obter pesos do modelo
    SELECT * INTO weights FROM public.get_model_weights();

    -- Calcular Strength Score
    player1_strength_score := public.normalize_elo_score(p1_surface_elo, p2_surface_elo);
    player2_strength_score := 100 - player1_strength_score;

    -- Calcular Ranking Score
    SELECT coalesce(p.ranking_points, 0) INTO p1_ranking FROM public.players p WHERE p.id = p_player1_id;
    SELECT coalesce(p.ranking_points, 0) INTO p2_ranking FROM public.players p WHERE p.id = p_player2_id;
    
    player1_ranking_score := 50 + (p1_ranking - p2_ranking) / 3;
    player1_ranking_score := greatest(0, least(100, player1_ranking_score));
    player2_ranking_score := 100 - player1_ranking_score;

    -- Obter Form Score
    SELECT * INTO form_record1 FROM public.get_player_form(p_player1_id, p_before_date);
    SELECT * INTO form_record2 FROM public.get_player_form(p_player2_id, p_before_date);

    player1_form_score := form_record1.combined_form;
    player2_form_score := form_record2.combined_form;

    -- Obter Surface Score
    IF p_surface IS NOT NULL THEN
        SELECT * INTO surface_record1 FROM public.get_surface_score(p_player1_id, p_surface, p_before_date);
        SELECT * INTO surface_record2 FROM public.get_surface_score(p_player2_id, p_surface, p_before_date);
        player1_surface_score := surface_record1.surface_score;
        player2_surface_score := surface_record2.surface_score;
    ELSE
        player1_surface_score := NULL;
        player2_surface_score := NULL;
    END IF;

    -- Obter Serve/Return Score
    SELECT * INTO serve_record1 FROM public.get_player_serve_return(p_player1_id, p_surface, p_before_date);
    SELECT * INTO serve_record2 FROM public.get_player_serve_return(p_player2_id, p_surface, p_before_date);

    player1_serve_score := serve_record1.serve_rating;
    player2_serve_score := serve_record2.serve_rating;
    player1_return_score := serve_record1.return_rating;
    player2_return_score := serve_record2.return_rating;

    -- Obter H2H Score
    IF p_match_id IS NOT NULL THEN
        SELECT * INTO h2h_record FROM public.get_h2h_score(p_player1_id, p_player2_id, p_surface, p_before_date);
        player1_h2h_score := h2h_record.h2h_score;
        player2_h2h_score := 100 - player1_h2h_score;
    ELSE
        player1_h2h_score := NULL;
        player2_h2h_score := NULL;
    END IF;

    -- Obter Market Score
    IF p_match_id IS NOT NULL THEN
        SELECT * INTO market_record FROM public.get_market_score(p_match_id, p_before_date);
        player1_market_score := market_record.player1_probability;
        player2_market_score := market_record.player2_probability;
    ELSE
        player1_market_score := NULL;
        player2_market_score := NULL;
    END IF;

    -- Obter Context Score
    SELECT * INTO context_record1 FROM public.get_context_score(p_player1_id, p_surface, p_before_date);
    SELECT * INTO context_record2 FROM public.get_context_score(p_player2_id, p_surface, p_before_date);

    player1_context_score := context_record1.context_score;
    player2_context_score := context_record2.context_score;

    -- Calcular Agreement Score
    agreement_total := 0;
    agreement_count := 0;

    IF player1_strength_score IS NOT NULL AND player1_strength_score > 50 THEN
        agreement_total := agreement_total + 1;
    ELSIF player1_strength_score IS NOT NULL THEN
        agreement_total := agreement_total + 0;
    END IF;
    agreement_count := agreement_count + 1;

    IF player1_form_score IS NOT NULL AND player1_form_score > 50 THEN
        agreement_total := agreement_total + 1;
    ELSIF player1_form_score IS NOT NULL THEN
        agreement_total := agreement_total + 0;
    END IF;
    agreement_count := agreement_count + 1;

    IF player1_surface_score IS NOT NULL AND player1_surface_score > 50 THEN
        agreement_total := agreement_total + 1;
    ELSIF player1_surface_score IS NOT NULL THEN
        agreement_total := agreement_total + 0;
    END IF;
    agreement_count := agreement_count + 1;

    IF player1_serve_score IS NOT NULL AND player1_serve_score > 50 THEN
        agreement_total := agreement_total + 1;
    ELSIF player1_serve_score IS NOT NULL THEN
        agreement_total := agreement_total + 0;
    END IF;
    agreement_count := agreement_count + 1;

    IF player1_h2h_score IS NOT NULL AND player1_h2h_score > 50 THEN
        agreement_total := agreement_total + 1;
    ELSIF player1_h2h_score IS NOT NULL THEN
        agreement_total := agreement_total + 0;
    END IF;
    agreement_count := agreement_count + 1;

    IF player1_ranking_score IS NOT NULL AND player1_ranking_score > 50 THEN
        agreement_total := agreement_total + 1;
    ELSIF player1_ranking_score IS NOT NULL THEN
        agreement_total := agreement_total + 0;
    END IF;
    agreement_count := agreement_count + 1;

    IF agreement_count > 0 THEN
        agreement_score := round((agreement_total::numeric / agreement_count) * 100, 2);
    ELSE
        agreement_score := 50.0;
    END IF;

    -- Calcular Data Quality Score
    quality_score := 0;
    quality_count := 0;

    IF player1_strength_score IS NOT NULL AND player2_strength_score IS NOT NULL THEN
        quality_score := quality_score + 25;
        quality_count := quality_count + 1;
    END IF;

    IF player1_form_score IS NOT NULL AND player2_form_score IS NOT NULL THEN
        quality_score := quality_score + 20;
        quality_count := quality_count + 1;
    END IF;

    IF player1_surface_score IS NOT NULL AND player2_surface_score IS NOT NULL THEN
        quality_score := quality_score + 20;
        quality_count := quality_count + 1;
    END IF;

    IF player1_serve_score IS NOT NULL AND player2_serve_score IS NOT NULL THEN
        quality_score := quality_score + 15;
        quality_count := quality_count + 1;
    END IF;

    IF player1_h2h_score IS NOT NULL AND player2_h2h_score IS NOT NULL THEN
        quality_score := quality_score + 10;
        quality_count := quality_count + 1;
    END IF;

    IF player1_ranking_score IS NOT NULL AND player2_ranking_score IS NOT NULL THEN
        quality_score := quality_score + 10;
        quality_count := quality_count + 1;
    END IF;

    IF player1_market_score IS NOT NULL AND player2_market_score IS NOT NULL THEN
        quality_score := quality_score + 10;
        quality_count := quality_count + 1;
    END IF;

    IF player1_context_score IS NOT NULL AND player2_context_score IS NOT NULL THEN
        quality_score := quality_score + 10;
        quality_count := quality_count + 1;
    END IF;

    IF quality_count > 0 THEN
        data_quality_score := round(quality_score, 2);
    ELSE
        data_quality_score := 0;
    END IF;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 4. FUNÇÃO: Converter diferença em probabilidade (logística)
-- ============================================================

create or replace function public.difference_to_probability(
    p_difference numeric,
    p_scale numeric default 100.0
)
returns table (
    player1_probability numeric,
    player2_probability numeric
)
language plpgsql
as $$
declare
    prob numeric;
begin
    IF p_difference IS NULL THEN
        player1_probability := 50.0;
        player2_probability := 50.0;
        RETURN NEXT;
        RETURN;
    END IF;

    prob := 1.0 / (1.0 + exp(-p_difference / p_scale));
    player1_probability := round(prob * 100, 2);
    player2_probability := round((1.0 - prob) * 100, 2);

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 5. FUNÇÃO: Calcular previsão completa para um jogo
-- ============================================================

create or replace function public.calculate_full_prediction(
    p_match_id bigint
)
returns table (
    player1_probability numeric,
    player2_probability numeric,
    confidence_score numeric,
    confidence_level text,
    predicted_winner_id bigint,
    model_version text,
    agreement_score numeric,
    data_quality_score numeric
)
language plpgsql
as $$
declare
    match_record record;
    p1_id bigint;
    p2_id bigint;
    surface text;
    scheduled_at timestamptz;
    match_scores record;
    weights record;
    p1_advantage numeric;
    p2_advantage numeric;
    advantage_diff numeric;
    winner_id bigint;
    p1_ranking numeric;
    p2_ranking numeric;
begin
    SELECT m.player1_id, m.player2_id, m.surface, m.scheduled_at
    INTO p1_id, p2_id, surface, scheduled_at
    FROM public.matches m
    WHERE m.id = p_match_id;

    IF p1_id IS NULL OR p2_id IS NULL THEN
        player1_probability := 50.0;
        player2_probability := 50.0;
        confidence_score := 10.0;
        confidence_level := 'incerto';
        predicted_winner_id := NULL;
        model_version := 'v2_elo';
        agreement_score := 50.0;
        data_quality_score := 0;
        RETURN NEXT;
        RETURN;
    END IF;

    SELECT * INTO match_scores FROM public.calculate_match_score(p1_id, p2_id, surface, scheduled_at, p_match_id);
    SELECT * INTO weights FROM public.get_model_weights();

    -- Calcular vantagem ponderada
    p1_advantage := 0;
    p2_advantage := 0;

    IF match_scores.player1_strength_score IS NOT NULL THEN
        p1_advantage := p1_advantage + (match_scores.player1_strength_score - 50) * weights.strength_weight;
        p2_advantage := p2_advantage + (match_scores.player2_strength_score - 50) * weights.strength_weight;
    END IF;

    IF match_scores.player1_form_score IS NOT NULL THEN
        p1_advantage := p1_advantage + (match_scores.player1_form_score - 50) * weights.form_weight;
        p2_advantage := p2_advantage + (match_scores.player2_form_score - 50) * weights.form_weight;
    END IF;

    IF match_scores.player1_surface_score IS NOT NULL THEN
        p1_advantage := p1_advantage + (match_scores.player1_surface_score - 50) * weights.surface_weight;
        p2_advantage := p2_advantage + (match_scores.player2_surface_score - 50) * weights.surface_weight;
    END IF;

    IF match_scores.player1_serve_score IS NOT NULL THEN
        p1_advantage := p1_advantage + (match_scores.player1_serve_score - 50) * weights.serve_weight;
        p2_advantage := p2_advantage + (match_scores.player2_serve_score - 50) * weights.serve_weight;
    END IF;

    IF match_scores.player1_return_score IS NOT NULL THEN
        p1_advantage := p1_advantage + (match_scores.player1_return_score - 50) * weights.return_weight;
        p2_advantage := p2_advantage + (match_scores.player2_return_score - 50) * weights.return_weight;
    END IF;

    IF match_scores.player1_h2h_score IS NOT NULL THEN
        p1_advantage := p1_advantage + (match_scores.player1_h2h_score - 50) * weights.h2h_weight;
        p2_advantage := p2_advantage + (match_scores.player2_h2h_score - 50) * weights.h2h_weight;
    END IF;

    IF match_scores.player1_ranking_score IS NOT NULL THEN
        p1_advantage := p1_advantage + (match_scores.player1_ranking_score - 50) * weights.ranking_weight;
        p2_advantage := p2_advantage + (match_scores.player2_ranking_score - 50) * weights.ranking_weight;
    END IF;

    IF match_scores.player1_market_score IS NOT NULL THEN
        p1_advantage := p1_advantage + (match_scores.player1_market_score - 50) * weights.market_weight;
        p2_advantage := p2_advantage + (match_scores.player2_market_score - 50) * weights.market_weight;
    END IF;

    IF match_scores.player1_context_score IS NOT NULL THEN
        p1_advantage := p1_advantage + (match_scores.player1_context_score - 50) * weights.context_weight;
        p2_advantage := p2_advantage + (match_scores.player2_context_score - 50) * weights.context_weight;
    END IF;

    advantage_diff := p1_advantage - p2_advantage;

    -- Tiebreaker: se vantagem for 0, usar ranking points ou ID do jogador
    IF advantage_diff = 0 THEN
        SELECT coalesce(p.ranking_points, 0) INTO p1_ranking FROM public.players p WHERE p.id = p1_id;
        SELECT coalesce(p.ranking_points, 0) INTO p2_ranking FROM public.players p WHERE p.id = p2_id;

        IF p1_ranking > p2_ranking THEN
            advantage_diff := 2.0;
        ELSIF p2_ranking > p1_ranking THEN
            advantage_diff := -2.0;
        ELSE
            advantage_diff := (p1_id - p2_id) * 1.0;
        END IF;
    END IF;

    -- Converter diferença em probabilidade
    SELECT * INTO player1_probability, player2_probability
    FROM public.difference_to_probability(advantage_diff, 100.0);

    -- Calcular Confidence Score
    confidence_score := 50;

    confidence_score := confidence_score + abs(advantage_diff) * 0.4;
    confidence_score := confidence_score + match_scores.agreement_score * 0.3;
    confidence_score := confidence_score + match_scores.data_quality_score * 0.2;
    confidence_score := confidence_score + 10;

    confidence_score := greatest(10, least(95, confidence_score));
    confidence_score := round(confidence_score, 0);

    IF confidence_score < 50 THEN
        confidence_level := 'incerto';
    ELSIF confidence_score < 60 THEN
        confidence_level := 'perigoso';
    ELSIF confidence_score < 70 THEN
        confidence_level := 'tendencia';
    ELSE
        confidence_level := 'forte';
    END IF;

    -- Determinar vencedor previsto
    IF player1_probability > player2_probability THEN
        winner_id := p1_id;
    ELSIF player2_probability > player1_probability THEN
        winner_id := p2_id;
    ELSE
        winner_id := p1_id;
    END IF;

    model_version := 'v2_elo';
    agreement_score := match_scores.agreement_score;
    data_quality_score := match_scores.data_quality_score;
    predicted_winner_id := winner_id;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 6. FUNÇÃO: Gerar previsão e guardar na BD
-- ============================================================

create or replace function public.generate_prediction(p_match_id bigint)
returns bigint
language plpgsql
as $$
declare
    pred record;
    pred_id bigint;
    factors record;
begin
    SELECT * INTO pred FROM public.calculate_full_prediction(p_match_id);

    SELECT * INTO factors FROM public.calculate_match_score(
        (SELECT player1_id FROM matches WHERE id = p_match_id),
        (SELECT player2_id FROM matches WHERE id = p_match_id),
        (SELECT surface FROM matches WHERE id = p_match_id),
        (SELECT scheduled_at FROM matches WHERE id = p_match_id),
        p_match_id
    );

    INSERT INTO public.match_predictions (
        match_id,
        player1_probability,
        player2_probability,
        confidence_score,
        confidence_level,
        predicted_winner_id,
        model_version,
        created_at
    ) VALUES (
        p_match_id,
        pred.player1_probability,
        pred.player2_probability,
        pred.confidence_score,
        pred.confidence_level,
        pred.predicted_winner_id,
        pred.model_version,
        now()
    )
    ON CONFLICT (match_id) DO UPDATE SET
        player1_probability = excluded.player1_probability,
        player2_probability = excluded.player2_probability,
        confidence_score = excluded.confidence_score,
        confidence_level = excluded.confidence_level,
        predicted_winner_id = excluded.predicted_winner_id,
        model_version = excluded.model_version,
        created_at = now()
    RETURNING id INTO pred_id;

    INSERT INTO public.match_prediction_factors (
        match_id,
        prediction_id,
        player1_strength_score,
        player2_strength_score,
        player1_form_score,
        player2_form_score,
        player1_surface_score,
        player2_surface_score,
        player1_serve_score,
        player2_serve_score,
        player1_return_score,
        player2_return_score,
        player1_h2h_score,
        player2_h2h_score,
        player1_market_score,
        player2_market_score,
        player1_context_score,
        player2_context_score,
        agreement_score,
        data_quality_score,
        created_at
    ) VALUES (
        p_match_id,
        pred_id,
        factors.player1_strength_score,
        factors.player2_strength_score,
        factors.player1_form_score,
        factors.player2_form_score,
        factors.player1_surface_score,
        factors.player2_surface_score,
        factors.player1_serve_score,
        factors.player2_serve_score,
        factors.player1_return_score,
        factors.player2_return_score,
        factors.player1_h2h_score,
        factors.player2_h2h_score,
        factors.player1_market_score,
        factors.player2_market_score,
        factors.player1_context_score,
        factors.player2_context_score,
        pred.agreement_score,
        pred.data_quality_score,
        now()
    )
    ON CONFLICT (match_id) DO UPDATE SET
        prediction_id = excluded.prediction_id,
        player1_strength_score = excluded.player1_strength_score,
        player2_strength_score = excluded.player2_strength_score,
        player1_form_score = excluded.player1_form_score,
        player2_form_score = excluded.player2_form_score,
        player1_surface_score = excluded.player1_surface_score,
        player2_surface_score = excluded.player2_surface_score,
        player1_serve_score = excluded.player1_serve_score,
        player2_serve_score = excluded.player2_serve_score,
        player1_return_score = excluded.player1_return_score,
        player2_return_score = excluded.player2_return_score,
        player1_h2h_score = excluded.player1_h2h_score,
        player2_h2h_score = excluded.player2_h2h_score,
        player1_market_score = excluded.player1_market_score,
        player2_market_score = excluded.player2_market_score,
        player1_context_score = excluded.player1_context_score,
        player2_context_score = excluded.player2_context_score,
        agreement_score = excluded.agreement_score,
        data_quality_score = excluded.data_quality_score,
        created_at = now();

    UPDATE public.matches SET
        confidence_score = pred.confidence_score,
        confidence_level = pred.confidence_level,
        predicted_winner_id = pred.predicted_winner_id,
        player1_probability = pred.player1_probability,
        player2_probability = pred.player2_probability
    WHERE id = p_match_id;

    RETURN pred_id;
END;
$$;


-- ============================================================
-- 7. FUNÇÃO: Gerar previsões para todos os jogos
-- ============================================================

create or replace function public.generate_all_predictions()
returns integer
language plpgsql
as $$
declare
    match_record record;
    count integer := 0;
begin
    FOR match_record IN
        SELECT m.id, m.status, m.winner_id
        FROM public.matches m
        LEFT JOIN public.match_predictions mp ON mp.match_id = m.id
        WHERE mp.id is null
          AND m.status in ('upcoming', 'live', 'completed')
          AND m.player1_id is not null
          AND m.player2_id is not null
    LOOP
        PERFORM public.generate_prediction(match_record.id);
        count := count + 1;

        IF match_record.status = 'completed' AND match_record.winner_id IS NOT NULL THEN
            UPDATE public.match_predictions SET
                was_correct = (predicted_winner_id = match_record.winner_id),
                result = CASE WHEN predicted_winner_id = match_record.winner_id THEN 'correct' ELSE 'incorrect' END
            WHERE match_id = match_record.id;
        END IF;
    END LOOP;

    RETURN count;
END;
$$;
