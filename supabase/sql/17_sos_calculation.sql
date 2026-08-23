-- ============================================================
-- TENNIS PREDICTOR - STRENGTH OF SCHEDULE (SOS)
-- ============================================================

-- ============================================================
-- 1. FUNÇÃO: Calcular SOS baseado em Elo dos adversários
-- ============================================================

create or replace function public.calculate_sos_score(
    p_player_id bigint,
    p_surface text,
    p_before_date timestamptz,
    p_last_n integer default 20
)
returns table (
    sos_score numeric,
    average_opponent_elo numeric,
    matches_considered integer
)
language plpgsql
as $$
declare
    match_record record;
    opponent_id bigint;
    opponent_elo numeric;
    opponent_surface_elo numeric;
    use_surface_elo boolean := false;
    sum_elo numeric := 0;
    count_matches integer := 0;
    avg_elo numeric;
begin
    -- Verificar se temos dados de superfície suficientes
    IF p_surface IS NOT NULL THEN
        SELECT count(*) INTO use_surface_elo
        FROM public.matches m
        WHERE (m.player1_id = p_player_id OR m.player2_id = p_player_id)
          AND m.surface = p_surface
          AND m.status = 'completed'
          AND m.winner_id IS NOT NULL
          AND m.scheduled_at < p_before_date;
    END IF;

    FOR match_record IN
        SELECT m.player1_id, m.player2_id, m.surface, m.scheduled_at
        FROM public.matches m
        WHERE (m.player1_id = p_player_id OR m.player2_id = p_player_id)
          AND m.status = 'completed'
          AND m.winner_id IS NOT NULL
          AND m.scheduled_at < p_before_date
        ORDER BY m.scheduled_at DESC
        LIMIT p_last_n
    LOOP
        -- Identificar adversário
        IF match_record.player1_id = p_player_id THEN
            opponent_id := match_record.player2_id;
        ELSE
            opponent_id := match_record.player1_id;
        END IF;

        -- Obter Elo do adversário
        SELECT coalesce(elo_rating, 1500) INTO opponent_elo
        FROM public.players
        WHERE id = opponent_id;

        IF opponent_elo IS NULL THEN
            opponent_elo := 1500;
        END IF;

        -- Se temos superfície e dados suficientes, usar surface Elo
        IF p_surface IS NOT NULL AND use_surface_elo THEN
            SELECT coalesce(pp.elo_rating, opponent_elo) INTO opponent_surface_elo
            FROM public.player_performance pp
            WHERE pp.player_id = opponent_id
              AND pp.surface = p_surface
              AND pp.period_end < p_before_date
            ORDER BY pp.period_end DESC
            LIMIT 1;

            IF opponent_surface_elo IS NOT NULL THEN
                sum_elo := sum_elo + opponent_surface_elo;
            ELSE
                sum_elo := sum_elo + opponent_elo;
            END IF;
        ELSE
            sum_elo := sum_elo + opponent_elo;
        END IF;

        count_matches := count_matches + 1;
    END LOOP;

    IF count_matches > 0 THEN
        avg_elo := round(sum_elo / count_matches, 2);
        -- SOS score: média do Elo dos adversários normalizado para 0-100
        -- Elo 1500 = 50, Elo 2000 = 100, Elo 1000 = 0
        sos_score := round(50 + (avg_elo - 1500) / 50, 2);
        sos_score := greatest(0, least(100, sos_score));
        average_opponent_elo := avg_elo;
        matches_considered := count_matches;
    ELSE
        sos_score := NULL;
        average_opponent_elo := NULL;
        matches_considered := 0;
    END IF;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 2. FUNÇÃO: Normalizar SOS score
-- ============================================================

create or replace function public.normalize_sos_score(
    p_sos_score numeric,
    p_min numeric default 40,
    p_max numeric default 60
)
returns numeric
language plpgsql
as $$
begin
    IF p_sos_score IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN round(
        greatest(0, least(100,
            (p_sos_score - p_min) / nullif(p_max - p_min, 0) * 100
        )),
        2
    );
end;
$$;


-- ============================================================
-- 3. FUNÇÃO: Obter SOS completo de um jogador
-- ============================================================

create or replace function public.get_player_sos(
    p_player_id bigint,
    p_surface text,
    p_before_date timestamptz
)
returns table (
    sos_raw numeric,
    sos_normalized numeric,
    average_opponent_elo numeric,
    matches_considered integer,
    data_quality text
)
language plpgsql
as $$
declare
    sos_record record;
begin
    SELECT * INTO sos_record FROM public.calculate_sos_score(p_player_id, p_surface, p_before_date);

    IF sos_record.sos_score IS NOT NULL THEN
        sos_raw := sos_record.sos_score;
        average_opponent_elo := sos_record.average_opponent_elo;
        matches_considered := sos_record.matches_considered;

        -- Normalizar se tivermos dados suficientes
        IF sos_record.matches_considered >= 1 THEN
            sos_normalized := public.normalize_sos_score(sos_record.sos_score);
            data_quality := 'limited';
        ELSE
            sos_normalized := NULL;
            data_quality := 'no_data';
        END IF;
    ELSE
        sos_raw := NULL;
        sos_normalized := NULL;
        average_opponent_elo := NULL;
        matches_considered := 0;
        data_quality := 'no_data';
    END IF;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 4. FUNÇÃO: Recalcular SOS para todos os jogadores
-- ============================================================

create or replace function public.recalculate_all_sos()
returns integer
language plpgsql
as $$
declare
    player_record record;
    count integer := 0;
    sos_record record;
    v_period_start date;
    v_period_end date;
    surfaces text[] := ARRAY['hard', 'clay', 'grass', 'indoor'];
    v_surface text;
begin
    FOR player_record IN
        SELECT DISTINCT player_id
        FROM public.player_performance
    LOOP
        -- Calcular SOS geral (sem superfície específica)
        SELECT * INTO sos_record
        FROM public.get_player_sos(player_record.player_id, NULL, now());

        IF sos_record.sos_normalized IS NOT NULL THEN
            v_period_start := date_trunc('month', now() - interval '1 month')::date;
            v_period_end := (date_trunc('month', now()) + interval '1 month - 1 day')::date;

            UPDATE public.player_performance pp
            SET strength_of_schedule = sos_record.sos_normalized,
                updated_at = now()
            WHERE pp.player_id = player_record.player_id
              AND pp.period_start = v_period_start
              AND pp.period_end = v_period_end;

            count := count + 1;
        END IF;

        -- Calcular SOS por superfície
        FOR v_surface IN SELECT unnest(surfaces)
        LOOP
            SELECT * INTO sos_record
            FROM public.get_player_sos(player_record.player_id, v_surface, now());

            IF sos_record.sos_normalized IS NOT NULL THEN
                v_period_start := date_trunc('month', now() - interval '1 month')::date;
                v_period_end := (date_trunc('month', now()) + interval '1 month - 1 day')::date;

                UPDATE public.player_performance pp
                SET strength_of_schedule = sos_record.sos_normalized,
                    updated_at = now()
                WHERE pp.player_id = player_record.player_id
                  AND pp.surface = v_surface
                  AND pp.period_start = v_period_start
                  AND pp.period_end = v_period_end;

                count := count + 1;
            END IF;
        END LOOP;
    END LOOP;

    RETURN count;
end;
$$;
