-- ============================================================
-- TENNIS PREDICTOR - CONTEXT CALCULATION
-- ============================================================

-- ============================================================
-- 1. FUNÇÃO: Calcular context score
-- ============================================================

create or replace function public.calculate_context_score(
    p_player_id bigint,
    p_surface text,
    p_before_date timestamptz,
    p_tournament_round text default NULL
)
returns table (
    context_score numeric,
    days_since_last_match integer,
    matches_last_14_days integer,
    consecutive_days_playing integer,
    surface_changed boolean,
    round_importance text,
    data_quality text
)
language plpgsql
as $$
declare
    match_record record;
    last_match_date timestamptz;
    current_date timestamptz;
    current_ts timestamptz := p_before_date;
    days_since integer := 0;
    matches_14_days integer := 0;
    consecutive_days integer := 0;
    last_surface text;
    surface_changed_flag boolean := false;
    round_importance_val text := 'unknown';
    score_components numeric := 0;
    score_count integer := 0;
    context_score_val numeric;
begin
    current_ts := p_before_date;

    -- Encontrar último jogo do jogador
    SELECT max(m.scheduled_at) INTO last_match_date
    FROM public.matches m
    WHERE (m.player1_id = p_player_id OR m.player2_id = p_player_id)
      AND m.status = 'completed'
      AND m.winner_id IS NOT NULL
      AND m.scheduled_at < p_before_date;

    IF last_match_date IS NOT NULL THEN
        days_since := COALESCE(EXTRACT(EPOCH FROM (current_ts - last_match_date)) / 86400, 0)::integer;
        IF days_since < 0 THEN
            days_since := 0;
        END IF;

        -- Calcular jogos nos últimos 14 dias
        SELECT count(*) INTO matches_14_days
        FROM public.matches m
        WHERE (m.player1_id = p_player_id OR m.player2_id = p_player_id)
          AND m.status = 'completed'
          AND m.winner_id IS NOT NULL
          AND m.scheduled_at >= current_ts - interval '14 days'
          AND m.scheduled_at < current_ts;

        -- Verificar sequência de jogos consecutivos
        SELECT count(*) INTO consecutive_days
        FROM public.matches m
        WHERE (m.player1_id = p_player_id OR m.player2_id = p_player_id)
          AND m.status = 'completed'
          AND m.winner_id IS NOT NULL
          AND m.scheduled_at >= current_ts - interval '7 days'
          AND m.scheduled_at < current_ts;

        -- Verificar mudança de superfície
        SELECT m.surface INTO last_surface
        FROM public.matches m
        WHERE (m.player1_id = p_player_id OR m.player2_id = p_player_id)
          AND m.status = 'completed'
          AND m.winner_id IS NOT NULL
          AND m.scheduled_at < current_ts
        ORDER BY m.scheduled_at DESC
        LIMIT 1;

        IF last_surface IS NOT NULL AND p_surface IS NOT NULL AND last_surface != p_surface THEN
            surface_changed_flag := true;
        END IF;
    END IF;

    -- Importância da fase do torneio
    IF p_tournament_round IS NOT NULL THEN
        CASE 
            WHEN p_tournament_round IN ('Final', 'Semifinal', 'Quarterfinal') THEN
                round_importance_val := 'high';
            WHEN p_tournament_round IN ('Round of 16', 'Round of 32', 'Round of 64') THEN
                round_importance_val := 'medium';
            ELSE
                round_importance_val := 'normal';
        END CASE;
    END IF;

    -- Calcular context score
    context_score_val := 50.0;

    IF days_since > 0 THEN
        context_score_val := context_score_val + (days_since::numeric / 10);
        score_count := score_count + 1;
    END IF;

    IF matches_14_days > 0 THEN
        context_score_val := context_score_val - (matches_14_days::numeric * 2);
        score_count := score_count + 1;
    END IF;

    IF consecutive_days > 0 THEN
        context_score_val := context_score_val - (consecutive_days::numeric * 3);
        score_count := score_count + 1;
    END IF;

    IF surface_changed_flag THEN
        context_score_val := context_score_val - 5;
        score_count := score_count + 1;
    END IF;

    IF round_importance_val = 'high' THEN
        context_score_val := context_score_val + 10;
        score_count := score_count + 1;
    ELSIF round_importance_val = 'medium' THEN
        context_score_val := context_score_val + 5;
        score_count := score_count + 1;
    END IF;

    IF score_count > 0 THEN
        context_score_val := greatest(0, least(100, context_score_val));
    ELSE
        context_score_val := 50.0;
    END IF;

    context_score := round(context_score_val, 2);
    days_since_last_match := days_since;
    matches_last_14_days := matches_14_days;
    consecutive_days_playing := consecutive_days;
    surface_changed := surface_changed_flag;
    round_importance := round_importance_val;
    data_quality := CASE WHEN score_count > 0 THEN 'partial' ELSE 'no_data' END;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 2. FUNÇÃO: Obter context score com fallback
-- ============================================================

create or replace function public.get_context_score(
    p_player_id bigint,
    p_surface text,
    p_before_date timestamptz,
    p_tournament_round text default NULL
)
returns table (
    context_score numeric,
    days_since_last_match integer,
    matches_last_14_days integer,
    consecutive_days_playing integer,
    surface_changed boolean,
    round_importance text,
    data_quality text
)
language plpgsql
as $$
declare
    context_record record;
begin
    SELECT * INTO context_record FROM public.calculate_context_score(p_player_id, p_surface, p_before_date, p_tournament_round);

    context_score := context_record.context_score;
    days_since_last_match := context_record.days_since_last_match;
    matches_last_14_days := context_record.matches_last_14_days;
    consecutive_days_playing := context_record.consecutive_days_playing;
    surface_changed := context_record.surface_changed;
    round_importance := context_record.round_importance;
    data_quality := context_record.data_quality;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 3. FUNÇÃO: Recalcular context para todos os jogadores
-- ============================================================

create or replace function public.recalculate_all_context()
returns integer
language plpgsql
as $$
declare
    player_record record;
    count integer := 0;
    context_record record;
    v_period_start date;
    v_period_end date;
begin
    FOR player_record IN
        SELECT DISTINCT player_id
        FROM public.player_performance
    LOOP
        SELECT * INTO context_record
        FROM public.get_context_score(player_record.player_id, NULL, now());

        IF context_record.context_score IS NOT NULL THEN
            v_period_start := date_trunc('month', now() - interval '1 month')::date;
            v_period_end := (date_trunc('month', now()) + interval '1 month - 1 day')::date;

            UPDATE public.player_performance pp
            SET dominance_score = context_record.context_score,
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
