-- ============================================================
-- TENNIS PREDICTOR - ODDS MANAGEMENT
-- ============================================================

-- ============================================================
-- 1. FUNÇÃO: Upsert odds e regenerar previsão
-- ============================================================

create or replace function public.upsert_match_odds(
    p_match_id bigint,
    p_player1_odd numeric,
    p_player2_odd numeric,
    p_market text default 'match_winner',
    p_source text default 'manual',
    p_captured_at timestamptz default now()
)
returns void
language plpgsql
as $$
begin
    INSERT INTO public.odds (
        match_id, player1_odd, player2_odd, market, source, captured_at
    ) VALUES (
        p_match_id, p_player1_odd, p_player2_odd, p_market, p_source, p_captured_at
    )
    ON CONFLICT (match_id, market, source) DO UPDATE SET
        player1_odd = excluded.player1_odd,
        player2_odd = excluded.player2_odd,
        captured_at = excluded.captured_at;

    PERFORM public.generate_prediction(p_match_id);
end;
$$;


-- ============================================================
-- 2. FUNÇÃO: Regenerar previsões para jogos com odds atualizadas
-- ============================================================

create or replace function public.regenerate_predictions_with_odds(
    p_hours_back integer default 24
)
returns integer
language plpgsql
as $$
declare
    match_record record;
    count integer := 0;
begin
    FOR match_record IN
        SELECT DISTINCT o.match_id
        FROM public.odds o
        WHERE o.captured_at > now() - (p_hours_back || ' hours')::interval
          AND EXISTS (
              SELECT 1 FROM public.matches m
              WHERE m.id = o.match_id
                AND m.status = 'upcoming'
          )
    LOOP
        PERFORM public.generate_prediction(match_record.match_id);
        count := count + 1;
    END LOOP;

    RETURN count;
end;
$$;


-- ============================================================
-- 3. FUNÇÃO: Obter odds atuais para um jogo
-- ============================================================

create or replace function public.get_current_odds(
    p_match_id bigint
)
returns table (
    player1_odd numeric,
    player2_odd numeric,
    market text,
    source text,
    captured_at timestamptz,
    player1_probability numeric,
    player2_probability numeric,
    margin numeric
)
language plpgsql
as $$
declare
    odds_record record;
begin
    SELECT o.player1_odd, o.player2_odd, o.market, o.source, o.captured_at
    INTO odds_record
    FROM public.odds o
    WHERE o.match_id = p_match_id
    ORDER BY o.captured_at DESC
    LIMIT 1;

    IF odds_record.player1_odd IS NULL THEN
        RETURN NEXT;
        RETURN;
    END IF;

    SELECT * INTO player1_probability, player2_probability, margin
    FROM public.normalize_odds_probability(odds_record.player1_odd, odds_record.player2_odd);

    player1_odd := odds_record.player1_odd;
    player2_odd := odds_record.player2_odd;
    market := odds_record.market;
    source := odds_record.source;
    captured_at := odds_record.captured_at;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 4. FUNÇÃO: Obter histórico de odds para um jogo
-- ============================================================

create or replace function public.get_odds_history(
    p_match_id bigint,
    p_source text default NULL
)
returns table (
    player1_odd numeric,
    player2_odd numeric,
    market text,
    source text,
    captured_at timestamptz,
    player1_probability numeric,
    player2_probability numeric,
    margin numeric
)
language plpgsql
as $$
begin
    RETURN QUERY
    SELECT 
        o.player1_odd,
        o.player2_odd,
        o.market,
        o.source,
        o.captured_at,
        np.player1_probability,
        np.player2_probability,
        np.margin
    FROM public.odds o
    LEFT JOIN LATERAL 
        public.normalize_odds_probability(o.player1_odd, o.player2_odd) np ON true
    WHERE o.match_id = p_match_id
      AND (p_source IS NULL OR o.source = p_source)
    ORDER BY o.captured_at DESC;
end;
$$;


-- ============================================================
-- 5. FUNÇÃO: Limpar odds antigas
-- ============================================================

create or replace function public.cleanup_old_odds(
    p_days_old integer default 30
)
returns integer
language plpgsql
as $$
declare
    deleted_count integer;
begin
    DELETE FROM public.odds
    WHERE captured_at < now() - (p_days_old || ' days')::interval
      AND match_id IN (
          SELECT id FROM public.matches WHERE status = 'completed'
      );

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
end;
$$;


-- ============================================================
-- 6. FUNÇÃO: Estatísticas de odds
-- ============================================================

create or replace function public.get_odds_stats()
returns table (
    total_odds integer,
    matches_with_odds integer,
    sources jsonb,
    avg_margin numeric,
    oldest_odds timestamptz,
    newest_odds timestamptz
)
language plpgsql
as $$
declare
    sources_data jsonb;
    margin_val numeric;
begin
    SELECT count(*)::integer INTO total_odds FROM public.odds;
    SELECT count(DISTINCT match_id)::integer INTO matches_with_odds FROM public.odds;
    SELECT jsonb_object_agg(source, cnt) INTO sources_data
    FROM (SELECT source, count(*) as cnt FROM public.odds WHERE source IS NOT NULL GROUP BY source) s;
    SELECT avg(np.margin) INTO margin_val
    FROM public.odds o
    LEFT JOIN LATERAL public.normalize_odds_probability(o.player1_odd, o.player2_odd) np ON true;
    SELECT min(captured_at) INTO oldest_odds FROM public.odds;
    SELECT max(captured_at) INTO newest_odds FROM public.odds;

    IF total_odds IS NULL THEN
        total_odds := 0;
        matches_with_odds := 0;
        sources_data := '{}'::jsonb;
        margin_val := NULL;
        oldest_odds := NULL;
        newest_odds := NULL;
    END IF;

    sources := sources_data;
    avg_margin := margin_val;
    RETURN NEXT;
END;
$$;
