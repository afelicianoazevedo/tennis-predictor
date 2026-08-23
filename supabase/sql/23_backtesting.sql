-- ============================================================
-- TENNIS PREDICTOR - BACKTESTING
-- ============================================================

-- ============================================================
-- 1. CRIAR TABELA DE RESULTADOS DE BACKTESTING
-- ============================================================

CREATE TABLE IF NOT EXISTS public.backtesting_results (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    match_id bigint NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
    match_date timestamptz NOT NULL,
    surface text,
    player1_id bigint NOT NULL,
    player2_id bigint NOT NULL,
    winner_id bigint,
    player1_probability numeric NOT NULL,
    player2_probability numeric NOT NULL,
    confidence_score numeric NOT NULL,
    confidence_level text NOT NULL,
    predicted_winner_id bigint,
    was_correct boolean,
    brier_score numeric,
    log_loss numeric,
    model_version text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backtesting_match_id ON public.backtesting_results(match_id);
CREATE INDEX IF NOT EXISTS idx_backtesting_match_date ON public.backtesting_results(match_date);
CREATE INDEX IF NOT EXISTS idx_backtesting_surface ON public.backtesting_results(surface);
CREATE INDEX IF NOT EXISTS idx_backtesting_model_version ON public.backtesting_results(model_version);


-- ============================================================
-- 2. FUNÇÃO: Calcular Brier Score
-- ============================================================

create or replace function public.calculate_brier_score(
    p_predicted_prob numeric,
    p_actual_outcome integer  -- 1 = jogador 1 ganhou, 0 = jogador 2 ganhou
)
returns numeric
language plpgsql
as $$
begin
    IF p_predicted_prob IS NULL OR p_actual_outcome IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN round(power(p_actual_outcome - p_predicted_prob / 100.0, 2), 4);
end;
$$;


-- ============================================================
-- 3. FUNÇÃO: Calcular Log Loss
-- ============================================================

create or replace function public.calculate_log_loss(
    p_predicted_prob numeric,
    p_actual_outcome integer  -- 1 = jogador 1 ganhou, 0 = jogador 2 ganhou
)
returns numeric
language plpgsql
as $$
declare
    prob numeric;
    clipped_prob numeric;
begin
    IF p_predicted_prob IS NULL OR p_actual_outcome IS NULL THEN
        RETURN NULL;
    END IF;

    prob := p_predicted_prob / 100.0;
    clipped_prob := greatest(0.001, least(0.999, prob));

    IF p_actual_outcome = 1 THEN
        RETURN round(-ln(clipped_prob), 4);
    ELSE
        RETURN round(-ln(1.0 - clipped_prob), 4);
    END IF;
end;
$$;


-- ============================================================
-- 4. FUNÇÃO: Executar backtesting
-- ============================================================

create or replace function public.run_backtesting(
    p_model_version text default 'v2_elo',
    p_start_date timestamptz default NULL,
    p_end_date timestamptz default NULL
)
returns integer
language plpgsql
as $$
declare
    match_record record;
    prediction record;
    brier_score_val numeric;
    log_loss_val numeric;
    actual_outcome integer;
    count integer := 0;
begin
    -- Limpar resultados anteriores do mesmo modelo
    DELETE FROM public.backtesting_results 
    WHERE model_version = p_model_version;

    FOR match_record IN
        SELECT m.id, m.scheduled_at, m.surface, m.player1_id, m.player2_id, m.winner_id
        FROM public.matches m
        WHERE m.status = 'completed'
          AND m.winner_id IS NOT NULL
          AND m.player1_id IS NOT NULL
          AND m.player2_id IS NOT NULL
          AND m.score IS NOT NULL
          AND m.score != '0-0'
        ORDER BY m.scheduled_at ASC
    LOOP
        -- Verificar filtro de data
        IF p_start_date IS NOT NULL AND match_record.scheduled_at < p_start_date THEN
            CONTINUE;
        END IF;

        IF p_end_date IS NOT NULL AND match_record.scheduled_at > p_end_date THEN
            CONTINUE;
        END IF;

        -- Gerar previsão usando apenas dados anteriores ao jogo
        PERFORM public.generate_prediction(match_record.id);

        SELECT * INTO prediction
        FROM public.match_predictions
        WHERE match_id = match_record.id;

        IF prediction.predicted_winner_id IS NULL THEN
            CONTINUE;
        END IF;

        -- Determinar resultado real
        IF match_record.winner_id = match_record.player1_id THEN
            actual_outcome := 1;
        ELSE
            actual_outcome := 0;
        END IF;

        -- Calcular Brier Score
        brier_score_val := public.calculate_brier_score(
            CASE WHEN match_record.winner_id = match_record.player1_id THEN prediction.player1_probability ELSE prediction.player2_probability END,
            actual_outcome
        );

        -- Calcular Log Loss
        log_loss_val := public.calculate_log_loss(
            CASE WHEN match_record.winner_id = match_record.player1_id THEN prediction.player1_probability ELSE prediction.player2_probability END,
            actual_outcome
        );

        -- Guardar resultado
        INSERT INTO public.backtesting_results (
            match_id, match_date, surface,
            player1_id, player2_id, winner_id,
            player1_probability, player2_probability,
            confidence_score, confidence_level,
            predicted_winner_id, was_correct,
            brier_score, log_loss, model_version
        ) VALUES (
            match_record.id, match_record.scheduled_at, match_record.surface,
            match_record.player1_id, match_record.player2_id, match_record.winner_id,
            prediction.player1_probability, prediction.player2_probability,
            prediction.confidence_score, prediction.confidence_level,
            prediction.predicted_winner_id, 
            prediction.predicted_winner_id = match_record.winner_id,
            brier_score_val, log_loss_val, p_model_version
        );

        count := count + 1;
    END LOOP;

    RETURN count;
end;
$$;


-- ============================================================
-- 5. FUNÇÃO: Calcular métricas de backtesting
-- ============================================================

create or replace function public.calculate_backtesting_metrics(
    p_model_version text default 'v2_elo',
    p_surface text default NULL
)
returns table (
    total_predictions integer,
    correct_predictions integer,
    accuracy numeric,
    brier_score_avg numeric,
    log_loss_avg numeric,
    calibration_error numeric,
    accuracy_incerto numeric,
    accuracy_perigoso numeric,
    accuracy_tendencia numeric,
    accuracy_forte numeric,
    total_incerto integer,
    total_perigoso integer,
    total_tendencia integer,
    total_forte integer
)
language plpgsql
as $$
begin
    RETURN QUERY
    WITH filtered AS (
        SELECT *
        FROM public.backtesting_results
        WHERE model_version = p_model_version
          AND (p_surface IS NULL OR surface = p_surface)
    ),
    confidence_groups AS (
        SELECT 
            CASE 
                WHEN confidence_score < 50 THEN 'incerto'
                WHEN confidence_score < 60 THEN 'perigoso'
                WHEN confidence_score < 70 THEN 'tendencia'
                ELSE 'forte'
            END as level,
            count(*) as total,
            count(*) filter (where was_correct = true) as correct,
            round(count(*) filter (where was_correct = true)::numeric / count(*) * 100, 2) as grp_accuracy
        FROM filtered
        GROUP BY level
    )
    SELECT 
        count(*)::integer as total_predictions,
        count(*) filter (where was_correct = true)::integer as correct_predictions,
        round(count(*) filter (where was_correct = true)::numeric / count(*) * 100, 2) as accuracy,
        round(avg(brier_score), 4) as brier_score_avg,
        round(avg(log_loss), 4) as log_loss_avg,
        round(abs(avg(player1_probability / 100.0 - CASE WHEN winner_id = player1_id THEN 1.0 ELSE 0.0 END)), 4) as calibration_error,
        COALESCE((SELECT grp_accuracy FROM confidence_groups WHERE level = 'incerto'), 0) as accuracy_incerto,
        COALESCE((SELECT grp_accuracy FROM confidence_groups WHERE level = 'perigoso'), 0) as accuracy_perigoso,
        COALESCE((SELECT grp_accuracy FROM confidence_groups WHERE level = 'tendencia'), 0) as accuracy_tendencia,
        COALESCE((SELECT grp_accuracy FROM confidence_groups WHERE level = 'forte'), 0) as accuracy_forte,
        COALESCE((SELECT count(*)::integer FROM confidence_groups WHERE level = 'incerto'), 0) as total_incerto,
        COALESCE((SELECT count(*)::integer FROM confidence_groups WHERE level = 'perigoso'), 0) as total_perigoso,
        COALESCE((SELECT count(*)::integer FROM confidence_groups WHERE level = 'tendencia'), 0) as total_tendencia,
        COALESCE((SELECT count(*)::integer FROM confidence_groups WHERE level = 'forte'), 0) as total_forte
    FROM filtered;
end;
$$;


-- ============================================================
-- 6. FUNÇÃO: Obter relatório de backtesting
-- ============================================================

create or replace function public.get_backtesting_report(
    p_model_version text default 'v2_elo'
)
returns table (
    metric_name text,
    metric_value numeric,
    metric_label text
)
language plpgsql
as $$
declare
    metrics record;
begin
    SELECT * INTO metrics FROM public.calculate_backtesting_metrics(p_model_version);

    metric_name := 'total_predictions';
    metric_value := metrics.total_predictions;
    metric_label := 'Total de Previsões';
    RETURN NEXT;

    metric_name := 'correct_predictions';
    metric_value := metrics.correct_predictions;
    metric_label := 'Previsões Corretas';
    RETURN NEXT;

    metric_name := 'accuracy';
    metric_value := metrics.accuracy;
    metric_label := 'Acurácia (%)';
    RETURN NEXT;

    metric_name := 'brier_score_avg';
    metric_value := metrics.brier_score_avg;
    metric_label := 'Brier Score (médio)';
    RETURN NEXT;

    metric_name := 'log_loss_avg';
    metric_value := metrics.log_loss_avg;
    metric_label := 'Log Loss (médio)';
    RETURN NEXT;

    metric_name := 'calibration_error';
    metric_value := metrics.calibration_error;
    metric_label := 'Erro de Calibração';
    RETURN NEXT;

    metric_name := 'accuracy_incerto';
    metric_value := metrics.accuracy_incerto;
    metric_label := 'Acurácia - Incerto (0-49)';
    RETURN NEXT;

    metric_name := 'accuracy_perigoso';
    metric_value := metrics.accuracy_perigoso;
    metric_label := 'Acurácia - Perigoso (50-59)';
    RETURN NEXT;

    metric_name := 'accuracy_tendencia';
    metric_value := metrics.accuracy_tendencia;
    metric_label := 'Acurácia - Tendência (60-69)';
    RETURN NEXT;

    metric_name := 'accuracy_forte';
    metric_value := metrics.accuracy_forte;
    metric_label := 'Acurácia - Forte (70-100)';
    RETURN NEXT;

    metric_name := 'total_incerto';
    metric_value := metrics.total_incerto;
    metric_label := 'Total - Incerto';
    RETURN NEXT;

    metric_name := 'total_perigoso';
    metric_value := metrics.total_perigoso;
    metric_label := 'Total - Perigoso';
    RETURN NEXT;

    metric_name := 'total_tendencia';
    metric_value := metrics.total_tendencia;
    metric_label := 'Total - Tendência';
    RETURN NEXT;

    metric_name := 'total_forte';
    metric_value := metrics.total_forte;
    metric_label := 'Total - Forte';
    RETURN NEXT;
end;
$$;


-- ============================================================
-- 7. FUNÇÃO: Limpar resultados de backtesting
-- ============================================================

create or replace function public.clear_backtesting_results(
    p_model_version text default NULL
)
returns integer
language plpgsql
as $$
declare
    deleted_count integer;
begin
    IF p_model_version IS NULL THEN
        DELETE FROM public.backtesting_results;
    ELSE
        DELETE FROM public.backtesting_results 
        WHERE model_version = p_model_version;
    END IF;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
end;
$$;
