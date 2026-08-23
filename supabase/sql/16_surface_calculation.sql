-- ============================================================
-- TENNIS PREDICTOR - SURFACE CALCULATION
-- ============================================================

-- ============================================================
-- 1. FUNÇÃO: Calcular estatísticas por superfície
-- ============================================================

create or replace function public.calculate_surface_stats(
    p_player_id bigint,
    p_surface text,
    p_before_date timestamptz
)
returns table (
    matches_played integer,
    wins integer,
    losses integer,
    sets_won integer,
    sets_lost integer,
    games_won integer,
    games_lost integer,
    win_percentage numeric,
    set_percentage numeric,
    game_percentage numeric
)
language plpgsql
as $$
declare
    match_record record;
    is_p1 boolean;
    player_score integer;
    opponent_score integer;
    player_sets_won integer;
    player_sets_lost integer;
    player_games_won integer;
    player_games_lost integer;
begin
    FOR match_record IN
        SELECT m.id, m.player1_id, m.player2_id, m.score, m.winner_id, m.scheduled_at
        FROM public.matches m
        WHERE (m.player1_id = p_player_id OR m.player2_id = p_player_id)
          AND m.surface = p_surface
          AND m.status = 'completed'
          AND m.winner_id IS NOT NULL
          AND m.scheduled_at < p_before_date
        ORDER BY m.scheduled_at DESC
    LOOP
        matches_played := matches_played + 1;

        is_p1 := (match_record.player1_id = p_player_id);

        IF is_p1 THEN
            player_score := COALESCE(CAST(split_part(match_record.score, '-', 1) AS INTEGER), 0);
            opponent_score := COALESCE(CAST(split_part(match_record.score, '-', 2) AS INTEGER), 0);
        ELSE
            player_score := COALESCE(CAST(split_part(match_record.score, '-', 2) AS INTEGER), 0);
            opponent_score := COALESCE(CAST(split_part(match_record.score, '-', 1) AS INTEGER), 0);
        END IF;

        player_sets_won := player_score;
        player_sets_lost := opponent_score;

        player_games_won := player_score * 6;
        player_games_lost := opponent_score * 6;

        IF match_record.winner_id = p_player_id THEN
            wins := wins + 1;
        ELSE
            losses := losses + 1;
        END IF;

        sets_won := sets_won + player_sets_won;
        sets_lost := sets_lost + player_sets_lost;
        games_won := games_won + player_games_won;
        games_lost := games_lost + player_games_lost;
    END LOOP;

    IF matches_played > 0 THEN
        win_percentage := round(wins::numeric / matches_played * 100, 2);
        IF sets_won + sets_lost > 0 THEN
            set_percentage := round(sets_won::numeric / (sets_won + sets_lost) * 100, 2);
        ELSE
            set_percentage := 50.0;
        END IF;
        IF games_won + games_lost > 0 THEN
            game_percentage := round(games_won::numeric / (games_won + games_lost) * 100, 2);
        ELSE
            game_percentage := 50.0;
        END IF;
    ELSE
        win_percentage := NULL;
        set_percentage := NULL;
        game_percentage := NULL;
    END IF;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 2. FUNÇÃO: Obter estatísticas gerais (overall) de um jogador
-- ============================================================

create or replace function public.get_player_overall_stats(
    p_player_id bigint,
    p_before_date timestamptz
)
returns table (
    matches_played integer,
    wins integer,
    losses integer,
    sets_won integer,
    sets_lost integer,
    games_won integer,
    games_lost integer,
    win_percentage numeric,
    set_percentage numeric,
    game_percentage numeric
)
language plpgsql
as $$
declare
    match_record record;
    is_p1 boolean;
    player_score integer;
    opponent_score integer;
    player_sets_won integer;
    player_sets_lost integer;
    player_games_won integer;
    player_games_lost integer;
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
        matches_played := matches_played + 1;

        is_p1 := (match_record.player1_id = p_player_id);

        IF is_p1 THEN
            player_score := COALESCE(CAST(split_part(match_record.score, '-', 1) AS INTEGER), 0);
            opponent_score := COALESCE(CAST(split_part(match_record.score, '-', 2) AS INTEGER), 0);
        ELSE
            player_score := COALESCE(CAST(split_part(match_record.score, '-', 2) AS INTEGER), 0);
            opponent_score := COALESCE(CAST(split_part(match_record.score, '-', 1) AS INTEGER), 0);
        END IF;

        player_sets_won := player_score;
        player_sets_lost := opponent_score;
        player_games_won := player_score * 6;
        player_games_lost := opponent_score * 6;

        IF match_record.winner_id = p_player_id THEN
            wins := wins + 1;
        ELSE
            losses := losses + 1;
        END IF;

        sets_won := sets_won + player_sets_won;
        sets_lost := sets_lost + player_sets_lost;
        games_won := games_won + player_games_won;
        games_lost := games_lost + player_games_lost;
    END LOOP;

    IF matches_played > 0 THEN
        win_percentage := round(wins::numeric / matches_played * 100, 2);
        IF sets_won + sets_lost > 0 THEN
            set_percentage := round(sets_won::numeric / (sets_won + sets_lost) * 100, 2);
        ELSE
            set_percentage := 50.0;
        END IF;
        IF games_won + games_lost > 0 THEN
            game_percentage := round(games_won::numeric / (games_won + games_lost) * 100, 2);
        ELSE
            game_percentage := 50.0;
        END IF;
    ELSE
        win_percentage := NULL;
        set_percentage := NULL;
        game_percentage := NULL;
    END IF;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 3. FUNÇÃO: Normalizar surface score para 0-100
-- ============================================================

create or replace function public.normalize_surface_score(
    p_win_pct numeric,
    p_set_pct numeric,
    p_game_pct numeric
)
returns numeric
language plpgsql
as $$
declare
    combined numeric;
    count_factors integer := 0;
begin
    IF p_win_pct IS NULL AND p_set_pct IS NULL AND p_game_pct IS NULL THEN
        RETURN NULL;
    END IF;

    combined := 0;
    count_factors := 0;

    IF p_win_pct IS NOT NULL THEN
        combined := combined + p_win_pct;
        count_factors := count_factors + 1;
    END IF;

    IF p_set_pct IS NOT NULL THEN
        combined := combined + p_set_pct;
        count_factors := count_factors + 1;
    END IF;

    IF p_game_pct IS NOT NULL THEN
        combined := combined + p_game_pct;
        count_factors := count_factors + 1;
    END IF;

    IF count_factors > 0 THEN
        RETURN round(combined / count_factors, 2);
    ELSE
        RETURN NULL;
    END IF;
END;
$$;


-- ============================================================
-- 4. FUNÇÃO: Obter surface score com fallback
-- ============================================================

create or replace function public.get_surface_score(
    p_player_id bigint,
    p_surface text,
    p_before_date timestamptz
)
returns table (
    surface_score numeric,
    surface_matches integer,
    overall_score numeric,
    data_quality text
)
language plpgsql
as $$
declare
    surface_record record;
    overall_record record;
    surface_normalized numeric;
    overall_normalized numeric;
    min_matches_for_surface integer := 3;
begin
    -- Tentar obter estatísticas da superfície específica
    SELECT * INTO surface_record FROM public.calculate_surface_stats(p_player_id, p_surface, p_before_date);

    -- Obter estatísticas gerais como fallback
    SELECT * INTO overall_record FROM public.get_player_overall_stats(p_player_id, p_before_date);

    IF surface_record.matches_played >= min_matches_for_surface THEN
        -- Dados suficientes da superfície: usar dados específicos
        surface_score := public.normalize_surface_score(
            surface_record.win_percentage,
            surface_record.set_percentage,
            surface_record.game_percentage
        );
        surface_matches := surface_record.matches_played;
        overall_score := NULL;
        data_quality := 'surface_data';
    ELSIF overall_record.matches_played > 0 THEN
        -- Dados insuficientes da superfície: usar overall
        surface_score := public.normalize_surface_score(
            overall_record.win_percentage,
            overall_record.set_percentage,
            overall_record.game_percentage
        );
        surface_matches := surface_record.matches_played;
        overall_score := surface_score;
        data_quality := 'overall_fallback';
    ELSE
        -- Sem dados suficientes
        surface_score := NULL;
        surface_matches := 0;
        overall_score := NULL;
        data_quality := 'no_data';
    END IF;

    RETURN NEXT;
END;
$$;


-- ============================================================
-- 5. FUNÇÃO: Atualizar player_performance com dados de superfície
-- ============================================================

create or replace function public.recalculate_surface_performance()
returns integer
language plpgsql
as $$
declare
    player_record record;
    count integer := 0;
    surface_record record;
    period_start date;
    period_end date;
    surfaces text[] := ARRAY['hard', 'clay', 'grass', 'indoor'];
    surface text;
    v_matches_played integer;
    v_wins integer;
    v_losses integer;
    v_sets_won integer;
    v_sets_lost integer;
    v_games_won integer;
    v_games_lost integer;
    v_win_pct numeric;
    v_set_pct numeric;
    v_game_pct numeric;
    v_surface_elo numeric;
begin
    FOR player_record IN
        SELECT DISTINCT player_id
        FROM public.player_performance
    LOOP
        FOR surface IN SELECT unnest(surfaces)
        LOOP
            SELECT * INTO surface_record
            FROM public.calculate_surface_stats(player_record.player_id, surface, now());

            IF surface_record.matches_played > 0 THEN
                v_matches_played := surface_record.matches_played;
                v_wins := surface_record.wins;
                v_losses := surface_record.losses;
                v_sets_won := surface_record.sets_won;
                v_sets_lost := surface_record.sets_lost;
                v_games_won := surface_record.games_won;
                v_games_lost := surface_record.games_lost;
                v_win_pct := surface_record.win_percentage;
                v_set_pct := surface_record.set_percentage;
                v_game_pct := surface_record.game_percentage;

                period_start := date_trunc('month', now() - interval '1 month')::date;
                period_end := (date_trunc('month', now()) + interval '1 month - 1 day')::date;

                UPDATE public.player_performance pp
                SET matches_played = v_matches_played,
                    wins = v_wins,
                    losses = v_losses,
                    sets_won = v_sets_won,
                    sets_lost = v_sets_lost,
                    games_won = v_games_won,
                    games_lost = v_games_lost,
                    win_percentage = v_win_pct,
                    set_percentage = v_set_pct,
                    game_percentage = v_game_pct,
                    updated_at = now()
                WHERE pp.player_id = player_record.player_id
                  AND pp.surface = surface;

                IF NOT FOUND THEN
                    INSERT INTO public.player_performance (
                        player_id, period_start, period_end, surface,
                        matches_played, wins, losses, sets_won, sets_lost, games_won, games_lost,
                        win_percentage, set_percentage, game_percentage,
                        created_at, updated_at
                    ) VALUES (
                        player_record.player_id, period_start, period_end, surface,
                        v_matches_played, v_wins, v_losses, v_sets_won, v_sets_lost, v_games_won, v_games_lost,
                        v_win_pct, v_set_pct, v_game_pct,
                        now(), now()
                    );
                END IF;

                count := count + 1;
            END IF;
        END LOOP;
    END LOOP;

    RETURN count;
end;
$$;
