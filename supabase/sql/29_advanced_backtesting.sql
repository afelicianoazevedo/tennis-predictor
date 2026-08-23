-- ============================================================
-- TENNIS PREDICTOR - ADVANCED BACKTESTING (Phase 16)
-- ============================================================

-- ============================================================
-- 1. EXTENDER TABELA DE BACKTESTING COM DADOS DE APOSTAS
-- ============================================================

ALTER TABLE public.backtesting_results
    ADD COLUMN IF NOT EXISTS player1_odd numeric,
    ADD COLUMN IF NOT EXISTS player2_odd numeric,
    ADD COLUMN IF NOT EXISTS market_margin numeric,
    ADD COLUMN IF NOT EXISTS stake numeric DEFAULT 10,
    ADD COLUMN IF NOT EXISTS profit_loss numeric,
    ADD COLUMN IF NOT EXISTS kelly_criterion numeric,
    ADD COLUMN IF NOT EXISTS value_bet boolean,
    ADD COLUMN IF NOT EXISTS odds_source text;

CREATE INDEX IF NOT EXISTS idx_backtesting_odds_source ON public.backtesting_results(odds_source);
CREATE INDEX IF NOT EXISTS idx_backtesting_value_bet ON public.backtesting_results(value_bet);


-- ============================================================
-- 2. FUNÇÃO: Calcular Kelly Criterion
-- ============================================================

create or replace function public.calculate_kelly_criterion(
    p_probability numeric,
    p_odds numeric,
    p_bankroll numeric DEFAULT 1000
)
returns numeric
language plpgsql
as $$
declare
    p numeric;
    q numeric;
    b numeric;
    kelly numeric;
begin
    IF p_probability IS NULL OR p_odds IS NULL OR p_odds <= 1 THEN
        RETURN 0;
    END IF;

    p := p_probability / 100.0;
    q := 1.0 - p;
    b := p_odds - 1.0;

    kelly := ((b * p) - q) / b;

    IF kelly < 0 THEN
        kelly := 0;
    END IF;

    kelly := least(kelly, 0.05);

    RETURN round(kelly * p_bankroll, 2);
end;
$$;


-- ============================================================
-- 3. FUNÇÃO: Calcular profit/loss de uma aposta
-- ============================================================

create or replace function public.calculate_bet_profit(
    p_stake numeric,
    p_odds numeric,
    p_won boolean
)
returns numeric
language plpgsql
as $$
begin
    IF p_stake IS NULL OR p_odds IS NULL OR p_won IS NULL THEN
        RETURN 0;
    END IF;

    IF p_won THEN
        RETURN round(p_stake * (p_odds - 1), 2);
    ELSE
        RETURN -p_stake;
    END IF;
end;
$$;


-- ============================================================
-- 4. FUNÇÃO: Identificar value bets
-- ============================================================

create or replace function public.identify_value_bets(
    p_model_probability numeric,
    p_market_probability numeric,
    p_margin numeric DEFAULT 0
)
returns boolean
language plpgsql
as $$
declare
    edge numeric;
    adjusted_market_prob numeric;
begin
    IF p_model_probability IS NULL OR p_market_probability IS NULL THEN
        RETURN false;
    END IF;

    adjusted_market_prob := p_market_probability * (1 - coalesce(p_margin, 0) / 100.0);

    edge := p_model_probability - adjusted_market_prob;

    RETURN edge > 5;
end;
$$;


-- ============================================================
-- 5. FUNÇÃO: Atualizar backtesting com odds
-- ============================================================

create or replace function public.update_backtesting_with_odds(
    p_model_version text default 'v2_elo'
)
returns integer
language plpgsql
as $$
declare
    backtest_record record;
    odds_record record;
    count integer := 0;
    edge numeric;
begin
    FOR backtest_record IN
        SELECT br.*
        FROM public.backtesting_results br
        WHERE br.model_version = p_model_version
          AND br.player1_odd IS NULL
        ORDER BY br.match_date ASC
    LOOP
        SELECT * INTO odds_record
        FROM public.get_odds_history(backtest_record.match_id)
        WHERE captured_at <= backtest_record.match_date
        ORDER BY captured_at DESC
        LIMIT 1;

        IF odds_record.player1_odd IS NOT NULL THEN
            UPDATE public.backtesting_results
            SET player1_odd = odds_record.player1_odd,
                player2_odd = odds_record.player2_odd,
                market_margin = odds_record.margin,
                odds_source = odds_record.source
            WHERE id = backtest_record.id;

            IF backtest_record.winner_id = backtest_record.player1_id THEN
                UPDATE public.backtesting_results
                SET profit_loss = public.calculate_bet_profit(stake, odds_record.player1_odd, was_correct),
                    kelly_criterion = public.calculate_kelly_criterion(
                        CASE WHEN backtest_record.winner_id = backtest_record.player1_id THEN backtest_record.player1_probability ELSE backtest_record.player2_probability END,
                        odds_record.player1_odd
                    ),
                    value_bet = public.identify_value_bets(
                        CASE WHEN backtest_record.winner_id = backtest_record.player1_id THEN backtest_record.player1_probability ELSE backtest_record.player2_probability END,
                        odds_record.player1_probability,
                        odds_record.margin
                    )
                WHERE id = backtest_record.id;
            ELSE
                UPDATE public.backtesting_results
                SET profit_loss = public.calculate_bet_profit(stake, odds_record.player2_odd, was_correct),
                    kelly_criterion = public.calculate_kelly_criterion(
                        CASE WHEN backtest_record.winner_id = backtest_record.player2_id THEN backtest_record.player2_probability ELSE backtest_record.player1_probability END,
                        odds_record.player2_odd
                    ),
                    value_bet = public.identify_value_bets(
                        CASE WHEN backtest_record.winner_id = backtest_record.player2_id THEN backtest_record.player2_probability ELSE backtest_record.player1_probability END,
                        odds_record.player2_probability,
                        odds_record.margin
                    )
                WHERE id = backtest_record.id;
            END IF;

            count := count + 1;
        END IF;
    END LOOP;

    RETURN count;
end;
$$;


-- ============================================================
-- 6. FUNÇÃO: Calcular métricas de apostas
-- ============================================================

create or replace function public.calculate_betting_metrics(
    p_model_version text default 'v2_elo'
)
returns table (
    total_bets integer,
    total_staked numeric,
    total_returned numeric,
    net_profit numeric,
    roi numeric,
    win_rate numeric,
    avg_odds numeric,
    profit_factor numeric,
    max_drawdown numeric,
    sharpe_ratio numeric,
    value_bets_count integer,
    value_bets_roi numeric
)
language plpgsql
as $$
declare
    backtest_record record;
    total_profit numeric := 0;
    total_stake numeric := 0;
    total_returned numeric := 0;
    wins integer := 0;
    total integer := 0;
    odds_sum numeric := 0;
    odds_count integer := 0;
    max_dd numeric := 0;
    current_dd numeric := 0;
    peak numeric := 0;
    value_profit numeric := 0;
    value_stake numeric := 0;
    value_count integer := 0;
    returns numeric[];
    i integer;
    mean_return numeric;
    std_dev numeric;
    sharpe numeric;
begin
    FOR backtest_record IN
        SELECT *
        FROM public.backtesting_results
        WHERE model_version = p_model_version
          AND player1_odd IS NOT NULL
        ORDER BY match_date ASC
    LOOP
        total := total + 1;
        total_stake := total_stake + backtest_record.stake;

        IF backtest_record.was_correct = true THEN
            wins := wins + 1;
            total_returned := total_returned + backtest_record.stake + backtest_record.profit_loss;
            total_profit := total_profit + backtest_record.profit_loss;
            odds_sum := odds_sum + CASE WHEN backtest_record.winner_id = backtest_record.player1_id THEN backtest_record.player1_odd ELSE backtest_record.player2_odd END;
            odds_count := odds_count + 1;
        ELSE
            total_profit := total_profit - backtest_record.stake;
        END IF;

        IF backtest_record.value_bet = true THEN
            value_count := value_count + 1;
            value_stake := value_stake + backtest_record.stake;
            IF backtest_record.was_correct = true THEN
                value_profit := value_profit + backtest_record.profit_loss;
            ELSE
                value_profit := value_profit - backtest_record.stake;
            END IF;
        END IF;

        current_dd := current_dd + backtest_record.profit_loss;
        IF current_dd > peak THEN
            peak := current_dd;
        END IF;
        max_dd := least(max_dd, current_dd - peak);
    END LOOP;

    IF total > 0 AND total_stake > 0 THEN
        roi := round((total_profit / total_stake) * 100, 2);
        win_rate := round((wins::numeric / total) * 100, 2);
        avg_odds := CASE WHEN odds_count > 0 THEN round(odds_sum / odds_count, 2) ELSE 0 END;
        profit_factor := CASE WHEN total_profit > 0 AND max_dd != 0 THEN round(total_profit / abs(max_dd), 2) ELSE 0 END;
        max_drawdown := abs(max_dd);
    ELSE
        roi := 0;
        win_rate := 0;
        avg_odds := 0;
        profit_factor := 0;
        max_drawdown := 0;
        value_count := 0;
        value_profit := 0;
        value_stake := 0;
    END IF;

    IF total > 1 THEN
        mean_return := total_profit / total;
        std_dev := sqrt(
            (SELECT avg(power(profit_loss - mean_return, 2))
             FROM public.backtesting_results
             WHERE model_version = p_model_version
               AND player1_odd IS NOT NULL)
        );
        sharpe := CASE WHEN std_dev IS NOT NULL AND std_dev > 0 THEN round(mean_return / std_dev, 2) ELSE 0 END;
    ELSE
        sharpe := 0;
    END IF;

    value_bets_roi := CASE WHEN value_stake > 0 THEN round((value_profit / value_stake) * 100, 2) ELSE 0 END;

    total_bets := total;
    total_staked := round(total_stake, 2);
    total_returned := round(total_returned, 2);
    net_profit := round(total_profit, 2);
    sharpe_ratio := sharpe;
    value_bets_count := value_count;

    RETURN NEXT;
end;
$$;


-- ============================================================
-- 7. FUNÇÃO: Calcular análise de streaks
-- ============================================================

create or replace function public.calculate_streak_analysis(
    p_model_version text default 'v2_elo'
)
returns table (
    max_win_streak integer,
    max_loss_streak integer,
    current_streak integer,
    current_streak_type text,
    streak_history jsonb
)
language plpgsql
as $$
declare
    streak integer := 0;
    max_win integer := 0;
    max_loss integer := 0;
    current_type text := NULL;
    history jsonb := '[]'::jsonb;
    backtest_record record;
begin
    FOR backtest_record IN
        SELECT *
        FROM public.backtesting_results
        WHERE model_version = p_model_version
          AND player1_odd IS NOT NULL
        ORDER BY match_date ASC
    LOOP
        IF backtest_record.was_correct = true THEN
            IF current_type = 'win' THEN
                streak := streak + 1;
            ELSE
                streak := 1;
                current_type := 'win';
            END IF;
            max_win := greatest(max_win, streak);
        ELSE
            IF current_type = 'loss' THEN
                streak := streak + 1;
            ELSE
                streak := 1;
                current_type := 'loss';
            END IF;
            max_loss := greatest(max_loss, streak);
        END IF;

        history := history || jsonb_build_object(
            'match_id', backtest_record.match_id,
            'date', backtest_record.match_date,
            'won', backtest_record.was_correct,
            'streak', streak,
            'type', current_type
        );
    END LOOP;

    max_win_streak := max_win;
    max_loss_streak := max_loss;
    current_streak := streak;
    current_streak_type := current_type;
    streak_history := history;

    RETURN NEXT;
end;
$$;


-- ============================================================
-- 8. FUNÇÃO: Relatório completo de backtesting
-- ============================================================

create or replace function public.get_full_backtesting_report(
    p_model_version text default 'v2_elo'
)
returns table (
    section text,
    metric text,
    value numeric,
    label text
)
language plpgsql
as $$
declare
    metrics record;
    betting_metrics record;
    streaks record;
begin
    SELECT * INTO metrics FROM public.calculate_backtesting_metrics(p_model_version);
    SELECT * INTO betting_metrics FROM public.calculate_betting_metrics(p_model_version);
    SELECT * INTO streaks FROM public.calculate_streak_analysis(p_model_version);

    section := 'accuracy';
    metric := 'total_predictions';
    value := metrics.total_predictions;
    label := 'Total de Previsões';
    RETURN NEXT;

    section := 'accuracy';
    metric := 'correct_predictions';
    value := metrics.correct_predictions;
    label := 'Previsões Corretas';
    RETURN NEXT;

    section := 'accuracy';
    metric := 'accuracy';
    value := metrics.accuracy;
    label := 'Acurácia (%)';
    RETURN NEXT;

    section := 'accuracy';
    metric := 'brier_score';
    value := metrics.brier_score_avg;
    label := 'Brier Score';
    RETURN NEXT;

    section := 'accuracy';
    metric := 'log_loss';
    value := metrics.log_loss_avg;
    label := 'Log Loss';
    RETURN NEXT;

    section := 'betting';
    metric := 'total_bets';
    value := betting_metrics.total_bets;
    label := 'Total de Apostas';
    RETURN NEXT;

    section := 'betting';
    metric := 'net_profit';
    value := betting_metrics.net_profit;
    label := 'Lucro/Prejuízo (€)';
    RETURN NEXT;

    section := 'betting';
    metric := 'roi';
    value := betting_metrics.roi;
    label := 'ROI (%)';
    RETURN NEXT;

    section := 'betting';
    metric := 'win_rate';
    value := betting_metrics.win_rate;
    label := 'Win Rate (%)';
    RETURN NEXT;

    section := 'betting';
    metric := 'avg_odds';
    value := betting_metrics.avg_odds;
    label := 'Odds Médias';
    RETURN NEXT;

    section := 'betting';
    metric := 'profit_factor';
    value := betting_metrics.profit_factor;
    label := 'Profit Factor';
    RETURN NEXT;

    section := 'betting';
    metric := 'max_drawdown';
    value := betting_metrics.max_drawdown;
    label := 'Max Drawdown (€)';
    RETURN NEXT;

    section := 'betting';
    metric := 'sharpe_ratio';
    value := betting_metrics.sharpe_ratio;
    label := 'Sharpe Ratio';
    RETURN NEXT;

    section := 'streaks';
    metric := 'max_win_streak';
    value := streaks.max_win_streak;
    label := 'Maior Sequência de Acertos';
    RETURN NEXT;

    section := 'streaks';
    metric := 'max_loss_streak';
    value := streaks.max_loss_streak;
    label := 'Maior Sequência de Erros';
    RETURN NEXT;

    section := 'value';
    metric := 'value_bets_count';
    value := betting_metrics.value_bets_count;
    label := 'Value Bets Identificadas';
    RETURN NEXT;

    section := 'value';
    metric := 'value_bets_roi';
    value := betting_metrics.value_bets_roi;
    label := 'ROI Value Bets (%)';
    RETURN NEXT;
end;
$$;


-- ============================================================
-- 9. FUNÇÃO: Comparar modelos
-- ============================================================

create or replace function public.compare_models(
    p_model_versions text[]
)
returns table (
    model_version text,
    total_predictions integer,
    accuracy numeric,
    brier_score numeric,
    roi numeric,
    profit numeric,
    sharpe_ratio numeric
)
language plpgsql
as $$
begin
    RETURN QUERY
    SELECT 
        br.model_version,
        count(*)::integer as total_predictions,
        round(count(*) filter (where was_correct = true)::numeric / count(*) * 100, 2) as accuracy,
        round(avg(brier_score), 4) as brier_score,
        round(avg(profit_loss) / 10 * 100, 2) as roi,
        round(sum(profit_loss), 2) as profit,
        round(stddev(profit_loss) / nullif(avg(profit_loss), 0), 2) as sharpe_ratio
    FROM public.backtesting_results br
    WHERE br.model_version = ANY(p_model_versions)
      AND br.player1_odd IS NOT NULL
    GROUP BY br.model_version
    ORDER BY accuracy DESC;
end;
$$;


-- ============================================================
-- 10. FUNÇÃO: Limpar backtesting
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
