-- ============================================================
-- TENNIS PREDICTOR - MARKET / ODDS CALCULATION
-- ============================================================

-- ============================================================
-- 1. FUNÇÃO: Converter odds em probabilidade implícita
-- ============================================================

create or replace function public.odds_to_probability(
    p_odd numeric
)
returns numeric
language plpgsql
as $$
begin
    IF p_odd IS NULL OR p_odd <= 1 THEN
        RETURN NULL;
    END IF;

    RETURN round(1.0 / p_odd * 100, 2);
end;
$$;


-- ============================================================
-- 2. FUNÇÃO: Corrigir overround e calcular probabilidades normalizadas
-- ============================================================

create or replace function public.normalize_odds_probability(
    p_player1_odd numeric,
    p_player2_odd numeric
)
returns table (
    player1_probability numeric,
    player2_probability numeric,
    margin numeric
)
language plpgsql
as $$
declare
    implied_p1 numeric;
    implied_p2 numeric;
    total_implied numeric;
    margin_pct numeric;
begin
    IF p_player1_odd IS NULL OR p_player2_odd IS NULL OR p_player1_odd <= 1 OR p_player2_odd <= 1 THEN
        player1_probability := NULL;
        player2_probability := NULL;
        margin := NULL;
        RETURN NEXT;
        RETURN;
    END IF;

    implied_p1 := 1.0 / p_player1_odd;
    implied_p2 := 1.0 / p_player2_odd;
    total_implied := implied_p1 + implied_p2;

    margin_pct := (total_implied - 1.0) * 100;

    player1_probability := round(implied_p1 / total_implied * 100, 2);
    player2_probability := round(implied_p2 / total_implied * 100, 2);
    margin := round(margin_pct, 2);

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 3. FUNÇÃO: Calcular market score
-- ============================================================

create or replace function public.calculate_market_score(
    p_match_id bigint,
    p_before_date timestamptz
)
returns table (
    market_score numeric,
    player1_probability numeric,
    player2_probability numeric,
    margin numeric,
    data_quality text
)
language plpgsql
as $$
declare
    odds_record record;
    p1_prob numeric;
    p2_prob numeric;
    margin_val numeric;
begin
    SELECT o.player1_odd, o.player2_odd, o.captured_at
    INTO odds_record
    FROM public.odds o
    WHERE o.match_id = p_match_id
      AND o.captured_at < p_before_date
    ORDER BY o.captured_at DESC
    LIMIT 1;

    IF odds_record.player1_odd IS NULL OR odds_record.player2_odd IS NULL THEN
        market_score := NULL;
        player1_probability := NULL;
        player2_probability := NULL;
        margin := NULL;
        data_quality := 'no_data';
        RETURN NEXT;
        RETURN;
    END IF;

    SELECT * INTO p1_prob, p2_prob, margin_val
    FROM public.normalize_odds_probability(odds_record.player1_odd, odds_record.player2_odd);

    IF p1_prob IS NULL OR p2_prob IS NULL THEN
        market_score := NULL;
        player1_probability := NULL;
        player2_probability := NULL;
        margin := NULL;
        data_quality := 'invalid_odds';
        RETURN NEXT;
        RETURN;
    END IF;

    market_score := p1_prob;
    player1_probability := p1_prob;
    player2_probability := p2_prob;
    margin := margin_val;
    data_quality := 'available';

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 4. FUNÇÃO: Obter market score com fallback
-- ============================================================

create or replace function public.get_market_score(
    p_match_id bigint,
    p_before_date timestamptz
)
returns table (
    market_score numeric,
    player1_probability numeric,
    player2_probability numeric,
    margin numeric,
    data_quality text
)
language plpgsql
as $$
declare
    market_record record;
begin
    SELECT * INTO market_record FROM public.calculate_market_score(p_match_id, p_before_date);

    IF market_record.data_quality = 'available' THEN
        market_score := market_record.market_score;
        player1_probability := market_record.player1_probability;
        player2_probability := market_record.player2_probability;
        margin := market_record.margin;
        data_quality := 'available';
    ELSE
        market_score := NULL;
        player1_probability := NULL;
        player2_probability := NULL;
        margin := NULL;
        data_quality := 'no_data';
    END IF;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 5. FUNÇÃO: Recalcular market para todos os jogos
-- ============================================================

create or replace function public.recalculate_all_market()
returns integer
language plpgsql
as $$
declare
    match_record record;
    count integer := 0;
    market_record record;
begin
    FOR match_record IN
        SELECT m.id
        FROM public.matches m
        WHERE m.status IN ('upcoming', 'live')
          AND m.player1_id IS NOT NULL
          AND m.player2_id IS NOT NULL
    LOOP
        SELECT * INTO market_record
        FROM public.get_market_score(match_record.id, now());

        IF market_record.data_quality = 'available' THEN
            UPDATE public.match_prediction_factors mpf
            SET player1_market_score = market_record.player1_probability,
                player2_market_score = market_record.player2_probability,
                updated_at = now()
            WHERE mpf.match_id = match_record.id;

            UPDATE public.matches m
            SET player1_market_probability = market_record.player1_probability,
                player2_market_probability = market_record.player2_probability,
                market_margin = market_record.margin
            WHERE m.id = match_record.id;

            count := count + 1;
        END IF;
    END LOOP;

    RETURN count;
end;
$$;
