-- ============================================================
-- TENNIS PREDICTOR - EXTENSÃO DO MODELO DE CLASSIFICAÇÃO
-- ============================================================

-- ============================================================
-- 1. HISTÓRICO DE PERFORMANCE DOS JOGADORES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.player_performance (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    player_id bigint NOT NULL
        REFERENCES public.players(id)
        ON DELETE CASCADE,

    period_start date NOT NULL,
    period_end date NOT NULL,

    surface text,

    matches_played integer DEFAULT 0,
    wins integer DEFAULT 0,
    losses integer DEFAULT 0,

    sets_won integer DEFAULT 0,
    sets_lost integer DEFAULT 0,

    games_won integer DEFAULT 0,
    games_lost integer DEFAULT 0,

    win_percentage numeric(5,2),
    set_percentage numeric(5,2),
    game_percentage numeric(5,2),

    ranking_at_period integer,
    ranking_points_at_period numeric,

    elo_rating numeric(8,2),
    surface_elo numeric(8,2),

    strength_of_schedule numeric(8,2),

    serve_rating numeric(8,2),
    return_rating numeric(8,2),

    dominance_score numeric(8,2),

    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT player_performance_period_check
        CHECK (period_end >= period_start),

    CONSTRAINT player_performance_unique
        UNIQUE (player_id, period_start, period_end, surface)
);

-- ============================================================
-- 2. ESTATÍSTICAS INDIVIDUAIS DOS JOGOS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.match_player_stats (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    match_id bigint NOT NULL
        REFERENCES public.matches(id)
        ON DELETE CASCADE,

    player_id bigint NOT NULL
        REFERENCES public.players(id)
        ON DELETE CASCADE,

    aces integer,
    double_faults integer,

    first_serve_percentage numeric(5,2),
    first_serve_points_won numeric(5,2),
    second_serve_points_won numeric(5,2),

    break_points_won integer,
    break_points_total integer,

    service_points_won integer,
    service_points_total integer,

    return_points_won integer,
    return_points_total integer,

    service_games_won integer,
    service_games_total integer,

    total_points_won integer,
    total_points_played integer,

    source text,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT match_player_stats_unique
        UNIQUE (match_id, player_id)
);

-- ============================================================
-- 3. H2H
-- ============================================================

CREATE TABLE IF NOT EXISTS public.player_h2h (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    player1_id bigint NOT NULL
        REFERENCES public.players(id)
        ON DELETE CASCADE,

    player2_id bigint NOT NULL
        REFERENCES public.players(id)
        ON DELETE CASCADE,

    matches_played integer DEFAULT 0,

    player1_wins integer DEFAULT 0,
    player2_wins integer DEFAULT 0,

    player1_sets_won integer DEFAULT 0,
    player2_sets_won integer DEFAULT 0,

    player1_games_won integer DEFAULT 0,
    player2_games_won integer DEFAULT 0,

    last_match_at timestamptz,

    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT h2h_different_players
        CHECK (player1_id <> player2_id),

    CONSTRAINT h2h_unique_pair
        UNIQUE (player1_id, player2_id)
);

-- ============================================================
-- 4. COMPONENTES DA PREVISÃO
-- ============================================================

CREATE TABLE IF NOT EXISTS public.match_prediction_factors (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    match_id bigint NOT NULL
        REFERENCES public.matches(id)
        ON DELETE CASCADE,

    prediction_id bigint
        REFERENCES public.match_predictions(id)
        ON DELETE CASCADE,

    player1_strength_score numeric(6,2),
    player2_strength_score numeric(6,2),

    player1_form_score numeric(6,2),
    player2_form_score numeric(6,2),

    player1_surface_score numeric(6,2),
    player2_surface_score numeric(6,2),

    player1_serve_score numeric(6,2),
    player2_serve_score numeric(6,2),

    player1_return_score numeric(6,2),
    player2_return_score numeric(6,2),

    player1_sos_score numeric(6,2),
    player2_sos_score numeric(6,2),

    player1_h2h_score numeric(6,2),
    player2_h2h_score numeric(6,2),

    player1_market_score numeric(6,2),
    player2_market_score numeric(6,2),

    player1_context_score numeric(6,2),
    player2_context_score numeric(6,2),

    agreement_score numeric(6,2),

    data_quality_score numeric(6,2),

    created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 5. ÍNDICES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_player_performance_player
    ON public.player_performance(player_id);

CREATE INDEX IF NOT EXISTS idx_player_performance_surface
    ON public.player_performance(surface);

CREATE INDEX IF NOT EXISTS idx_player_performance_period
    ON public.player_performance(period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_match_player_stats_match
    ON public.match_player_stats(match_id);

CREATE INDEX IF NOT EXISTS idx_match_player_stats_player
    ON public.match_player_stats(player_id);

CREATE INDEX IF NOT EXISTS idx_h2h_player1
    ON public.player_h2h(player1_id);

CREATE INDEX IF NOT EXISTS idx_h2h_player2
    ON public.player_h2h(player2_id);

CREATE INDEX IF NOT EXISTS idx_prediction_factors_match
    ON public.match_prediction_factors(match_id);

CREATE INDEX IF NOT EXISTS idx_prediction_factors_prediction
    ON public.match_prediction_factors(prediction_id);

-- ============================================================
-- 6. UPDATED_AT PARA MATCH_PLAYER_STATS
-- ============================================================

DROP TRIGGER IF EXISTS match_player_stats_updated_at ON public.match_player_stats;
CREATE TRIGGER match_player_stats_updated_at
BEFORE UPDATE ON public.match_player_stats
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 7. ATUALIZAR TIMESTAMP DE PLAYER_PERFORMANCE
-- ============================================================

DROP TRIGGER IF EXISTS player_performance_updated_at ON public.player_performance;
CREATE TRIGGER player_performance_updated_at
BEFORE UPDATE ON public.player_performance
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 8. ATUALIZAR TIMESTAMP DE H2H
-- ============================================================

DROP TRIGGER IF EXISTS player_h2h_updated_at ON public.player_h2h;
CREATE TRIGGER player_h2h_updated_at
BEFORE UPDATE ON public.player_h2h
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();
