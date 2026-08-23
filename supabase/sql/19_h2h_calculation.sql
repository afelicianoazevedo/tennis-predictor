-- ============================================================
-- TENNIS PREDICTOR - H2H CALCULATION
-- ============================================================

-- ============================================================
-- 1. FUNÇÃO: Calcular H2H score com decaimento temporal
-- ============================================================

create or replace function public.calculate_h2h_score(
    p_player1_id bigint,
    p_player2_id bigint,
    p_surface text,
    p_before_date timestamptz
)
returns table (
    h2h_score numeric,
    player1_wins integer,
    player2_wins integer,
    player1_sets_won integer,
    player2_sets_won integer,
    matches_considered integer,
    data_quality text
)
language plpgsql
as $$
declare
    match_record record;
    is_p1 boolean;
    player1_score integer;
    player2_score integer;
    player1_wins_count integer := 0;
    player2_wins_count integer := 0;
    player1_sets integer := 0;
    player2_sets integer := 0;
    count_matches integer := 0;
    recency_weight numeric;
    total_weight numeric := 0;
    weighted_score numeric := 0;
    days_diff integer;
    max_days integer := 730;
begin
    FOR match_record IN
        SELECT m.id, m.player1_id, m.player2_id, m.score, m.winner_id, m.scheduled_at, m.surface
        FROM public.matches m
        WHERE ((m.player1_id = p_player1_id AND m.player2_id = p_player2_id)
            OR (m.player1_id = p_player2_id AND m.player2_id = p_player1_id))
          AND m.status = 'completed'
          AND m.winner_id IS NOT NULL
          AND m.scheduled_at < p_before_date
        ORDER BY m.scheduled_at DESC
    LOOP
        -- Filtrar por superfície se especificada
        IF p_surface IS NOT NULL AND match_record.surface IS NOT NULL AND match_record.surface != p_surface THEN
            CONTINUE;
        END IF;

        is_p1 := (match_record.player1_id = p_player1_id);

        IF is_p1 THEN
            player1_score := COALESCE(CAST(split_part(match_record.score, '-', 1) AS INTEGER), 0);
            player2_score := COALESCE(CAST(split_part(match_record.score, '-', 2) AS INTEGER), 0);
        ELSE
            player1_score := COALESCE(CAST(split_part(match_record.score, '-', 2) AS INTEGER), 0);
            player2_score := COALESCE(CAST(split_part(match_record.score, '-', 1) AS INTEGER), 0);
        END IF;

        player1_sets := player1_sets + player1_score;
        player2_sets := player2_sets + player2_score;

        IF match_record.winner_id = p_player1_id THEN
            player1_wins_count := player1_wins_count + 1;
        ELSE
            player2_wins_count := player2_wins_count + 1;
        END IF;

        count_matches := count_matches + 1;

        -- Calcular peso por recência (decaimento exponencial)
        days_diff := COALESCE(EXTRACT(EPOCH FROM (p_before_date - match_record.scheduled_at)) / 86400, 0);
        recency_weight := exp(-days_diff / 180.0);
        total_weight := total_weight + recency_weight;

        IF match_record.winner_id = p_player1_id THEN
            weighted_score := weighted_score + recency_weight;
        ELSE
            weighted_score := weighted_score - recency_weight;
        END IF;
    END LOOP;

    matches_considered := count_matches;
    player1_wins := player1_wins_count;
    player2_wins := player2_wins_count;
    player1_sets_won := player1_sets;
    player2_sets_won := player2_sets;

    IF count_matches > 0 THEN
        -- Normalizar weighted_score para -100 a 100
        weighted_score := greatest(-100, least(100, (weighted_score / nullif(total_weight, 0)) * 100));

        -- Converter para score 0-100 (50 = empate)
        h2h_score := round(50 + weighted_score / 2, 2);
        data_quality := 'reliable';
    ELSE
        h2h_score := NULL;
        data_quality := 'no_data';
    END IF;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 2. FUNÇÃO: Obter H2H com fallback
-- ============================================================

create or replace function public.get_h2h_score(
    p_player1_id bigint,
    p_player2_id bigint,
    p_surface text,
    p_before_date timestamptz
)
returns table (
    h2h_score numeric,
    player1_wins integer,
    player2_wins integer,
    player1_sets_won integer,
    player2_sets_won integer,
    matches_considered integer,
    data_quality text
)
language plpgsql
as $$
declare
    h2h_record record;
begin
    SELECT * INTO h2h_record FROM public.calculate_h2h_score(p_player1_id, p_player2_id, p_surface, p_before_date);

    IF h2h_record.matches_considered >= 2 THEN
        h2h_score := h2h_record.h2h_score;
        player1_wins := h2h_record.player1_wins;
        player2_wins := h2h_record.player2_wins;
        player1_sets_won := h2h_record.player1_sets_won;
        player2_sets_won := h2h_record.player2_sets_won;
        matches_considered := h2h_record.matches_considered;
        data_quality := h2h_record.data_quality;
    ELSIF h2h_record.matches_considered = 1 THEN
        h2h_score := h2h_record.h2h_score;
        player1_wins := h2h_record.player1_wins;
        player2_wins := h2h_record.player2_wins;
        player1_sets_won := h2h_record.player1_sets_won;
        player2_sets_won := h2h_record.player2_sets_won;
        matches_considered := h2h_record.matches_considered;
        data_quality := 'limited';
    ELSE
        -- Sem H2H: usar 50 (neutro)
        h2h_score := 50.0;
        player1_wins := 0;
        player2_wins := 0;
        player1_sets_won := 0;
        player2_sets_won := 0;
        matches_considered := 0;
        data_quality := 'no_data';
    END IF;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 3. FUNÇÃO: Normalizar H2H score
-- ============================================================

create or replace function public.normalize_h2h_score(
    p_h2h_score numeric
)
returns numeric
language plpgsql
as $$
begin
    IF p_h2h_score IS NULL THEN
        RETURN 50.0;
    END IF;

    RETURN round(greatest(0, least(100, p_h2h_score)), 2);
end;
$$;


-- ============================================================
-- 4. FUNÇÃO: Atualizar player_h2h com dados calculados
-- ============================================================

create or replace function public.recalculate_all_h2h()
returns integer
language plpgsql
as $$
declare
    match_record record;
    count integer := 0;
    h2h_record record;
    p1_id bigint;
    p2_id bigint;
    surface text;
begin
    FOR match_record IN
        SELECT m.player1_id, m.player2_id, m.surface, m.scheduled_at
        FROM public.matches m
        WHERE m.status = 'completed'
          AND m.winner_id IS NOT NULL
          AND m.score IS NOT NULL
          AND m.score != '0-0'
        GROUP BY m.player1_id, m.player2_id, m.surface, m.scheduled_at
    LOOP
        p1_id := match_record.player1_id;
        p2_id := match_record.player2_id;
        surface := match_record.surface;

        SELECT * INTO h2h_record
        FROM public.calculate_h2h_score(p1_id, p2_id, surface, now());

        IF h2h_record.matches_considered > 0 THEN
            UPDATE public.player_h2h ph
            SET matches_played = h2h_record.matches_considered,
                player1_wins = h2h_record.player1_wins,
                player2_wins = h2h_record.player2_wins,
                player1_sets_won = h2h_record.player1_sets_won,
                player2_sets_won = h2h_record.player2_sets_won,
                last_match_at = match_record.scheduled_at,
                updated_at = now()
            WHERE ph.player1_id = p1_id
              AND ph.player2_id = p2_id;

            IF NOT FOUND THEN
                INSERT INTO public.player_h2h (
                    player1_id, player2_id,
                    matches_played, player1_wins, player2_wins,
                    player1_sets_won, player2_sets_won,
                    last_match_at, updated_at
                ) VALUES (
                    p1_id, p2_id,
                    h2h_record.matches_considered, h2h_record.player1_wins, h2h_record.player2_wins,
                    h2h_record.player1_sets_won, h2h_record.player2_sets_won,
                    match_record.scheduled_at, now()
                );
            END IF;

            count := count + 1;
        END IF;
    END LOOP;

    RETURN count;
end;
$$;
