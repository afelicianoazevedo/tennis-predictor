-- ============================================================
-- TENNIS PREDICTOR - PROBABILITY CALIBRATION
-- ============================================================

-- ============================================================
-- 1. CRIAR TABELA DE CALIBRAÇÃO
-- ============================================================

CREATE TABLE IF NOT EXISTS public.probability_calibration (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_version text NOT NULL,
    bin_start numeric NOT NULL,
    bin_end numeric NOT NULL,
    bin_mid numeric NOT NULL,
    predicted_count integer NOT NULL DEFAULT 0,
    actual_wins integer NOT NULL DEFAULT 0,
    actual_win_rate numeric NOT NULL DEFAULT 0,
    calibration_error numeric NOT NULL DEFAULT 0,
    a numeric,
    b numeric,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(model_version, bin_start, bin_end)
);

CREATE INDEX IF NOT EXISTS idx_calibration_model_version ON public.probability_calibration(model_version);


-- ============================================================
-- 2. FUNÇÃO: Calcular probabilidade calibrada (Platt Scaling)
-- ============================================================

create or replace function public.calibrate_probability(
    p_raw_probability numeric,
    p_model_version text default 'v2_elo'
)
returns numeric
language plpgsql
as $$
declare
    calibration record;
    logit numeric;
    calibrated numeric;
begin
    IF p_raw_probability IS NULL OR p_raw_probability <= 0 OR p_raw_probability >= 100 THEN
        RETURN p_raw_probability;
    END IF;

    logit := ln(p_raw_probability / (100.0 - p_raw_probability));

    SELECT * INTO calibration
    FROM public.probability_calibration
    WHERE model_version = p_model_version
      AND bin_start <= p_raw_probability
      AND bin_end > p_raw_probability
    ORDER BY bin_start
    LIMIT 1;

    IF calibration IS NULL OR calibration.a IS NULL OR calibration.b IS NULL THEN
        RETURN round(p_raw_probability, 2);
    END IF;

    calibrated := 1.0 / (1.0 + exp(-(calibration.a * logit + calibration.b)));

    RETURN round(greatest(1, least(99, calibrated * 100)), 2);
end;
$$;


-- ============================================================
-- 3. FUNÇÃO: Calcular curva de calibração
-- ============================================================

create or replace function public.calculate_calibration_curve(
    p_model_version text default 'v2_elo',
    p_num_bins integer default 10
)
returns table (
    bin_start numeric,
    bin_end numeric,
    bin_mid numeric,
    predicted_count integer,
    actual_wins integer,
    actual_win_rate numeric,
    calibration_error numeric
)
language plpgsql
as $$
declare
    bin_width numeric;
    bin_num integer;
    bin_start_val numeric;
    bin_end_val numeric;
    bin_count integer;
    bin_wins integer;
    bin_mid_val numeric;
begin
    bin_width := 100.0 / p_num_bins;

    FOR bin_num IN 0..(p_num_bins - 1) LOOP
        bin_start_val := bin_num * bin_width;
        bin_end_val := (bin_num + 1) * bin_width;
        bin_mid_val := (bin_start_val + bin_end_val) / 2;

        SELECT 
            count(*) as total,
            count(*) filter (where was_correct = true) as wins
        INTO bin_count, bin_wins
        FROM public.backtesting_results
        WHERE model_version = p_model_version
          AND player1_probability >= bin_start_val
          AND player1_probability < bin_end_val;

        IF bin_count > 0 THEN
            actual_win_rate := round(bin_wins::numeric / bin_count * 100, 2);
            calibration_error := round(abs(bin_mid_val - actual_win_rate), 2);
        ELSE
            actual_win_rate := NULL;
            calibration_error := NULL;
        END IF;

        predicted_count := bin_count;
        actual_wins := bin_wins;

        bin_start := bin_start_val;
        bin_end := bin_end_val;
        bin_mid := bin_mid_val;

        RETURN NEXT;
    END LOOP;
end;
$$;


-- ============================================================
-- 4. FUNÇÃO: Treinar calibrador (Platt Scaling)
-- ============================================================

create or replace function public.train_calibrator(
    p_model_version text default 'v2_elo',
    p_num_bins integer default 10
)
returns numeric
language plpgsql
as $$
declare
    calibration_data record;
    n integer;
    sum_logit numeric;
    sum_logit_y numeric;
    sum_logit2 numeric;
    train_a numeric;
    train_b numeric;
    logit numeric;
    target numeric;
    mean_logit numeric;
    mean_target numeric;
    numerator numeric;
    denominator numeric;
    calibration_error_total numeric := 0;
    calibration_count integer := 0;
begin
    -- Limpar calibração anterior
    DELETE FROM public.probability_calibration
    WHERE model_version = p_model_version;

    -- Calcular curva de calibração
    FOR calibration_data IN
        SELECT * FROM public.calculate_calibration_curve(p_model_version, p_num_bins)
        WHERE predicted_count > 0
    LOOP
        INSERT INTO public.probability_calibration (
            model_version, bin_start, bin_end, bin_mid,
            predicted_count, actual_wins, actual_win_rate, calibration_error
        ) VALUES (
            p_model_version,
            calibration_data.bin_start,
            calibration_data.bin_end,
            calibration_data.bin_mid,
            calibration_data.predicted_count,
            calibration_data.actual_wins,
            calibration_data.actual_win_rate,
            calibration_data.calibration_error
        );

        calibration_error_total := calibration_error_total + calibration_data.calibration_error;
        calibration_count := calibration_count + 1;
    END LOOP;

    -- Treinar Platt Scaling usando dados de backtesting
    SELECT count(*) INTO n FROM public.backtesting_results WHERE model_version = p_model_version;

    IF n < 10 THEN
        RETURN calibration_count;
    END IF;

    -- Calcular parâmetros A e B do Platt Scaling
    sum_logit := 0;
    sum_logit_y := 0;
    sum_logit2 := 0;

    FOR calibration_data IN
        SELECT 
            player1_probability,
            CASE WHEN winner_id = player1_id THEN 1.0 ELSE 0.0 END as actual
        FROM public.backtesting_results
        WHERE model_version = p_model_version
    LOOP
        logit := ln(calibration_data.player1_probability / (100.0 - calibration_data.player1_probability));
        sum_logit := sum_logit + logit;
        sum_logit_y := sum_logit_y + logit * calibration_data.actual;
        sum_logit2 := sum_logit2 + logit * logit;
    END LOOP;

    mean_logit := sum_logit / n;
    mean_target := (SELECT avg(CASE WHEN winner_id = player1_id THEN 1.0 ELSE 0.0 END) 
                    FROM public.backtesting_results 
                    WHERE model_version = p_model_version);

    numerator := sum_logit_y - n * mean_logit * mean_target;
    denominator := sum_logit2 - n * mean_logit * mean_logit;

    IF denominator != 0 THEN
        train_a := numerator / denominator;
        train_b := mean_target - train_a * mean_logit;
    ELSE
        train_a := 1;
        train_b := 0;
    END IF;

    -- Atualizar parâmetros na tabela de calibração
    UPDATE public.probability_calibration pc
    SET a = train_a, b = train_b, updated_at = now()
    WHERE pc.model_version = p_model_version;

    RETURN calibration_count;
end;
$$;


-- ============================================================
-- 5. FUNÇÃO: Obter relatório de calibração
-- ============================================================

create or replace function public.get_calibration_report(
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
    mce numeric := 0;
    max_mce_bin text := '';
begin
    metric_name := 'expected_calibration_error';
    SELECT round(coalesce(avg(calibration_error), 0), 4) INTO metric_value
    FROM public.probability_calibration
    WHERE model_version = p_model_version
      AND calibration_error IS NOT NULL;
    metric_label := 'Expected Calibration Error (ECE)';
    RETURN NEXT;

    metric_name := 'max_calibration_error';
    SELECT round(coalesce(max(calibration_error), 0), 4), round(coalesce(max(bin_mid), 0), 2)::text 
    INTO metric_value, max_mce_bin
    FROM public.probability_calibration
    WHERE model_version = p_model_version
      AND calibration_error IS NOT NULL;
    metric_label := 'Maximum Calibration Error (MCE)';
    RETURN NEXT;

    metric_name := 'calibration_bins';
    SELECT count(*) INTO metric_value
    FROM public.probability_calibration
    WHERE model_version = p_model_version;
    metric_label := 'Número de Bins';
    RETURN NEXT;

    metric_name := 'max_calibration_bin';
    metric_value := NULL;
    metric_label := 'Bin com Maior Erro (' || coalesce(max_mce_bin, 'N/A') || ')';
    RETURN NEXT;
end;
$$;


-- ============================================================
-- 6. FUNÇÃO: Limpar calibração
-- ============================================================

create or replace function public.clear_calibration(
    p_model_version text default NULL
)
returns integer
language plpgsql
as $$
declare
    deleted_count integer;
begin
    IF p_model_version IS NULL THEN
        DELETE FROM public.probability_calibration;
    ELSE
        DELETE FROM public.probability_calibration 
        WHERE model_version = p_model_version;
    END IF;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
end;
$$;
