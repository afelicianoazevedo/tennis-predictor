-- ============================================================
-- TENNIS PREDICTOR - FORM CALCULATION (FIXED v2)
-- ============================================================

-- Drop existing functions if they exist
DROP FUNCTION IF EXISTS public.calculate_form_score(bigint, timestamptz);
DROP FUNCTION IF EXISTS public.normalize_form_score(numeric, numeric, numeric);
DROP FUNCTION IF EXISTS public.get_player_form(bigint, timestamptz);
DROP FUNCTION IF EXISTS public.recalculate_all_form();

-- ============================================================
-- 1. FUNÇÃO: Calcular score de forma recente
-- ============================================================

create or replace function public.calculate_form_score(
    p_player_id bigint,
    p_before_date timestamptz
)
returns table (
    form_5 numeric,
    form_10 numeric,
    form_20 numeric,
    matches_5 integer,
    matches_10 integer,
    matches_20 integer
)
language plpgsql
as $$
declare
    match_record record;
    match_score numeric;
    count_5 integer := 0;
    count_10 integer := 0;
    count_20 integer := 0;
    sum_5 numeric := 0;
    sum_10 numeric := 0;
    sum_20 numeric := 0;
    p1_score integer;
    p2_score integer;
    is_p1 boolean;
    won boolean;
begin
    FOR match_record IN
        SELECT m.id, m.player1_id, m.player2_id, m.score, m.winner_id, m.scheduled_at
        FROM public.matches m
        WHERE (m.player1_id = p_player_id OR m.player2_id = p_player_id)
          AND m.status = 'completed'
          AND m.winner_id IS NOT NULL
          AND m.scheduled_at < p_before_date
        ORDER BY m.scheduled_at DESC
    LOOP
        is_p1 := (match_record.player1_id = p_player_id);
        won := (match_record.winner_id = p_player_id);

        IF is_p1 THEN
            p1_score := COALESCE(CAST(split_part(match_record.score, '-', 1) AS INTEGER), 0);
            p2_score := COALESCE(CAST(split_part(match_record.score, '-', 2) AS INTEGER), 0);
        ELSE
            p1_score := COALESCE(CAST(split_part(match_record.score, '-', 2) AS INTEGER), 0);
            p2_score := COALESCE(CAST(split_part(match_record.score, '-', 1) AS INTEGER), 0);
        END IF;

        match_score := CASE WHEN won THEN 60 ELSE 40 END;

        IF count_5 < 5 THEN
            count_5 := count_5 + 1;
            sum_5 := sum_5 + match_score;
        END IF;

        IF count_10 < 10 THEN
            count_10 := count_10 + 1;
            sum_10 := sum_10 + match_score;
        END IF;

        IF count_20 < 20 THEN
            count_20 := count_20 + 1;
            sum_20 := sum_20 + match_score;
        END IF;

        IF count_20 >= 20 THEN
            EXIT;
        END IF;
    END LOOP;

    form_5 := CASE WHEN count_5 >= 1 THEN round(sum_5 / count_5, 2) ELSE NULL END;
    form_10 := CASE WHEN count_10 >= 1 THEN round(sum_10 / count_10, 2) ELSE NULL END;
    form_20 := CASE WHEN count_20 >= 1 THEN round(sum_20 / count_20, 2) ELSE NULL END;
    matches_5 := count_5;
    matches_10 := count_10;
    matches_20 := count_20;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 2. FUNÇÃO: Normalizar form score para 0-100
-- ============================================================

create or replace function public.normalize_form_score(
    p_form_score numeric,
    p_min numeric default 30,
    p_max numeric default 70
)
returns numeric
language plpgsql
as $$
begin
    IF p_form_score IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN round(
        greatest(0, least(100,
            (p_form_score - p_min) / nullif(p_max - p_min, 0) * 100
        )),
        2
    );
end;
$$;


-- ============================================================
-- 3. FUNÇÃO: Obter form completo de um jogador
-- ============================================================

create or replace function public.get_player_form(
    p_player_id bigint,
    p_before_date timestamptz
)
returns table (
    form_5_raw numeric,
    form_10_raw numeric,
    form_20_raw numeric,
    form_5_normalized numeric,
    form_10_normalized numeric,
    form_20_normalized numeric,
    combined_form numeric,
    matches_5 integer,
    matches_10 integer,
    matches_20 integer
)
language plpgsql
as $$
declare
    form_record record;
    combined numeric;
begin
    SELECT * INTO form_record FROM public.calculate_form_score(p_player_id, p_before_date);

    form_5_normalized := public.normalize_form_score(form_record.form_5);
    form_10_normalized := public.normalize_form_score(form_record.form_10);
    form_20_normalized := public.normalize_form_score(form_record.form_20);

    combined := NULL;

    IF form_5_normalized IS NOT NULL AND form_10_normalized IS NOT NULL AND form_20_normalized IS NOT NULL THEN
        combined := round((form_5_normalized + form_10_normalized + form_20_normalized) / 3, 2);
    ELSIF form_5_normalized IS NOT NULL AND form_10_normalized IS NOT NULL THEN
        combined := round((form_5_normalized + form_10_normalized) / 2, 2);
    ELSIF form_5_normalized IS NOT NULL THEN
        combined := form_5_normalized;
    END IF;

    form_5_raw := form_record.form_5;
    form_10_raw := form_record.form_10;
    form_20_raw := form_record.form_20;
    matches_5 := form_record.matches_5;
    matches_10 := form_record.matches_10;
    matches_20 := form_record.matches_20;
    combined_form := combined;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 4. FUNÇÃO: Calcular forma para todos os jogadores
-- ============================================================

create or replace function public.recalculate_all_form()
returns integer
language plpgsql
as $$
declare
    player_record record;
    count integer := 0;
    form_record record;
    v_period_start date;
    v_period_end date;
begin
    FOR player_record IN
        SELECT DISTINCT player_id
        FROM public.player_performance
    LOOP
        SELECT * INTO form_record
        FROM public.get_player_form(player_record.player_id, now());

        IF form_record.combined_form IS NOT NULL THEN
            v_period_start := date_trunc('month', now() - interval '1 month')::date;
            v_period_end := (date_trunc('month', now()) + interval '1 month - 1 day')::date;

            UPDATE public.player_performance pp
            SET form_score = form_record.combined_form,
                form_5 = form_record.form_5_raw,
                form_10 = form_record.form_10_raw,
                form_20 = form_record.form_20_raw,
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
