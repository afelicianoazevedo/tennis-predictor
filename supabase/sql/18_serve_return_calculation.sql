-- ============================================================
-- TENNIS PREDICTOR - SERVE / RETURN RATING
-- ============================================================

-- ============================================================
-- 1. FUNÇÃO: Calcular serve rating
-- ============================================================

create or replace function public.calculate_serve_rating(
    p_player_id bigint,
    p_surface text,
    p_before_date timestamptz
)
returns table (
    serve_rating numeric,
    service_points_won integer,
    service_points_total integer,
    service_points_pct numeric,
    matches_considered integer,
    data_quality text
)
language plpgsql
as $$
declare
    match_record record;
    is_p1 boolean;
    v_service_won integer;
    v_service_total integer;
    v_total_won integer;
    v_total_played integer;
    v_service_pct numeric;
    count_matches integer := 0;
    v_service_points_won integer := 0;
    v_service_points_total integer := 0;
begin
    FOR match_record IN
        SELECT m.id, m.player1_id, m.player2_id, m.scheduled_at
        FROM public.matches m
        WHERE (m.player1_id = p_player_id OR m.player2_id = p_player_id)
          AND m.status = 'completed'
          AND m.winner_id IS NOT NULL
          AND m.scheduled_at < p_before_date
        ORDER BY m.scheduled_at DESC
        LIMIT 20
    LOOP
        is_p1 := (match_record.player1_id = p_player_id);

        IF is_p1 THEN
            v_service_won := COALESCE((SELECT mps.service_points_won FROM public.match_player_stats mps WHERE mps.match_id = match_record.id AND mps.player_id = p_player_id), 0);
            v_service_total := COALESCE((SELECT mps.service_points_total FROM public.match_player_stats mps WHERE mps.match_id = match_record.id AND mps.player_id = p_player_id), 0);
        ELSE
            v_service_won := COALESCE((SELECT mps.service_points_won FROM public.match_player_stats mps WHERE mps.match_id = match_record.id AND mps.player_id = p_player_id), 0);
            v_service_total := COALESCE((SELECT mps.service_points_total FROM public.match_player_stats mps WHERE mps.match_id = match_record.id AND mps.player_id = p_player_id), 0);
        END IF;

        IF v_service_total > 0 THEN
            v_service_points_won := v_service_points_won + v_service_won;
            v_service_points_total := v_service_points_total + v_service_total;
            count_matches := count_matches + 1;
        END IF;
    END LOOP;

    matches_considered := count_matches;

    IF count_matches > 0 AND v_service_points_total > 0 THEN
        v_service_pct := round(v_service_points_won::numeric / v_service_points_total * 100, 2);
        serve_rating := v_service_pct;
        service_points_won := v_service_points_won;
        service_points_total := v_service_points_total;
        service_points_pct := v_service_pct;
        data_quality := 'individual';
    ELSE
        serve_rating := 60.0;
        service_points_pct := NULL;
        data_quality := 'league_fallback';
    END IF;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 2. FUNÇÃO: Calcular return rating
-- ============================================================

create or replace function public.calculate_return_rating(
    p_player_id bigint,
    p_surface text,
    p_before_date timestamptz
)
returns table (
    return_rating numeric,
    return_points_won integer,
    return_points_total integer,
    return_points_pct numeric,
    matches_considered integer,
    data_quality text
)
language plpgsql
as $$
declare
    match_record record;
    is_p1 boolean;
    v_return_won integer;
    v_return_total integer;
    return_points_won integer := 0;
    return_points_total integer := 0;
    return_pct numeric;
    count_matches integer := 0;
begin
    FOR match_record IN
        SELECT m.id, m.player1_id, m.player2_id, m.scheduled_at
        FROM public.matches m
        WHERE (m.player1_id = p_player_id OR m.player2_id = p_player_id)
          AND m.status = 'completed'
          AND m.winner_id IS NOT NULL
          AND m.scheduled_at < p_before_date
        ORDER BY m.scheduled_at DESC
        LIMIT 20
    LOOP
        is_p1 := (match_record.player1_id = p_player_id);

        IF is_p1 THEN
            v_return_won := COALESCE((SELECT mps.return_points_won FROM public.match_player_stats mps WHERE mps.match_id = match_record.id AND mps.player_id = p_player_id), 0);
            v_return_total := COALESCE((SELECT mps.return_points_total FROM public.match_player_stats mps WHERE mps.match_id = match_record.id AND mps.player_id = p_player_id), 0);
        ELSE
            v_return_won := COALESCE((SELECT mps.return_points_won FROM public.match_player_stats mps WHERE mps.match_id = match_record.id AND mps.player_id = p_player_id), 0);
            v_return_total := COALESCE((SELECT mps.return_points_total FROM public.match_player_stats mps WHERE mps.match_id = match_record.id AND mps.player_id = p_player_id), 0);
        END IF;

        IF v_return_total > 0 THEN
            return_points_won := return_points_won + v_return_won;
            return_points_total := return_points_total + v_return_total;
            count_matches := count_matches + 1;
        END IF;
    END LOOP;

    matches_considered := count_matches;

    IF count_matches > 0 AND return_points_total > 0 THEN
        return_points_pct := round(return_points_won::numeric / return_points_total * 100, 2);
        return_rating := return_points_pct;
        data_quality := 'individual';
    ELSE
        return_rating := 40.0;
        return_points_pct := NULL;
        data_quality := 'league_fallback';
    END IF;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 3. FUNÇÃO: Normalizar serve/return rating
-- ============================================================

create or replace function public.normalize_serve_return_score(
    p_rating numeric,
    p_league_avg numeric default 50.0
)
returns numeric
language plpgsql
as $$
begin
    IF p_rating IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN round(
        greatest(0, least(100,
            p_rating + (p_rating - p_league_avg)
        )),
        2
    );
end;
$$;


-- ============================================================
-- 4. FUNÇÃO: Obter serve/return completo de um jogador
-- ============================================================

create or replace function public.get_player_serve_return(
    p_player_id bigint,
    p_surface text,
    p_before_date timestamptz
)
returns table (
    serve_rating numeric,
    return_rating numeric,
    serve_data_quality text,
    return_data_quality text
)
language plpgsql
as $$
declare
    serve_record record;
    return_record record;
begin
    SELECT * INTO serve_record FROM public.calculate_serve_rating(p_player_id, p_surface, p_before_date);
    SELECT * INTO return_record FROM public.calculate_return_rating(p_player_id, p_surface, p_before_date);

    serve_rating := serve_record.serve_rating;
    return_rating := return_record.return_rating;
    serve_data_quality := serve_record.data_quality;
    return_data_quality := return_record.data_quality;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 5. FUNÇÃO: Recalcular serve/return para todos os jogadores
-- ============================================================

create or replace function public.recalculate_serve_return()
returns integer
language plpgsql
as $$
declare
    player_record record;
    count integer := 0;
    serve_record record;
    return_record record;
    v_period_start date;
    v_period_end date;
begin
    FOR player_record IN
        SELECT DISTINCT player_id
        FROM public.player_performance
    LOOP
        SELECT * INTO serve_record
        FROM public.calculate_serve_rating(player_record.player_id, NULL, now());

        SELECT * INTO return_record
        FROM public.calculate_return_rating(player_record.player_id, NULL, now());

        IF serve_record.serve_rating IS NOT NULL OR return_record.return_rating IS NOT NULL THEN
            v_period_start := date_trunc('month', now() - interval '1 month')::date;
            v_period_end := (date_trunc('month', now()) + interval '1 month - 1 day')::date;

            UPDATE public.player_performance pp
            SET serve_rating = serve_record.serve_rating,
                return_rating = return_record.return_rating,
                updated_at = now()
            WHERE pp.player_id = player_record.player_id
              AND pp.period_start = v_period_start
              AND pp.period_end = v_period_end;

            count := count + 1;
        END IF;
    END LOOP;

    RETURN count;
end;
$$;
