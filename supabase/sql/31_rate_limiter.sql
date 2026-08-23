-- ============================================================
-- TENNIS PREDICTOR - RATE LIMITER FOR ODDS API
-- ============================================================
-- The Odds API: 500 requests/month
-- Safe daily limit: 15 requests/day = ~450/month
-- Weekly limit: 100 requests/week = safe buffer

-- ============================================================
-- 1. CRIAR TABELA DE RATE LIMITING
-- ============================================================

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    api_name text NOT NULL,
    request_date date NOT NULL DEFAULT CURRENT_DATE,
    request_count integer NOT NULL DEFAULT 0,
    month_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(api_name, request_date)
);

CREATE INDEX IF NOT EXISTS idx_api_rate_limits_date ON public.api_rate_limits(request_date);
CREATE INDEX IF NOT EXISTS idx_api_rate_limits_api_name ON public.api_rate_limits(api_name);


-- ============================================================
-- 2. FUNÇÃO: Verificar se pode fazer request
-- ============================================================

create or replace function public.can_make_api_request(
    p_api_name text default 'the_odds_api',
    p_daily_limit integer default 15,
    p_monthly_limit integer default 450
)
returns boolean
language plpgsql
as $$
declare
    today_count integer;
    month_count integer;
    today date := CURRENT_DATE;
    month_start date := DATE_TRUNC('month', CURRENT_DATE)::date;
begin
    SELECT request_count INTO today_count
    FROM public.api_rate_limits
    WHERE api_name = p_api_name AND request_date = today;

    SELECT COALESCE(SUM(request_count), 0) INTO month_count
    FROM public.api_rate_limits
    WHERE api_name = p_api_name AND request_date >= month_start;

    IF today_count IS NULL THEN
        today_count := 0;
    END IF;

    RETURN today_count < p_daily_limit AND month_count < p_monthly_limit;
end;
$$;


-- ============================================================
-- 3. FUNÇÃO: Registrar request
-- ============================================================

create or replace function public.record_api_request(
    p_api_name text default 'the_odds_api',
    p_count integer default 1
)
returns void
language plpgsql
as $$
declare
    today date := CURRENT_DATE;
    existing_record record;
begin
    SELECT * INTO existing_record
    FROM public.api_rate_limits
    WHERE api_name = p_api_name AND request_date = today;

    IF existing_record IS NULL THEN
        INSERT INTO public.api_rate_limits (api_name, request_date, request_count, month_count, updated_at)
        VALUES (p_api_name, today, p_count, p_count, now());
    ELSE
        UPDATE public.api_rate_limits
        SET request_count = request_count + p_count,
            month_count = month_count + p_count,
            updated_at = now()
        WHERE api_name = p_api_name AND request_date = today;
    END IF;
end;
$$;


-- ============================================================
-- 4. FUNÇÃO: Obter estatísticas de rate limit
-- ============================================================

create or replace function public.get_api_rate_limit_stats(
    p_api_name text default 'the_odds_api'
)
returns table (
    today_count integer,
    month_count integer,
    daily_limit integer,
    monthly_limit integer,
    remaining_today integer,
    remaining_month integer,
    can_request boolean
)
language plpgsql
as $$
declare
    today_count integer;
    month_count integer;
    daily_limit integer := 15;
    monthly_limit integer := 450;
    today date := CURRENT_DATE;
    month_start date := DATE_TRUNC('month', CURRENT_DATE)::date;
begin
    SELECT COALESCE(SUM(request_count), 0) INTO month_count
    FROM public.api_rate_limits
    WHERE api_name = p_api_name AND request_date >= month_start;

    SELECT COALESCE(request_count, 0) INTO today_count
    FROM public.api_rate_limits
    WHERE api_name = p_api_name AND request_date = today;

    today_count := COALESCE(today_count, 0);
    month_count := COALESCE(month_count, 0);

    remaining_today := greatest(0, daily_limit - today_count);
    remaining_month := greatest(0, monthly_limit - month_count);
    can_request := today_count < daily_limit AND month_count < monthly_limit;

    RETURN NEXT;
end;
$$;


-- ============================================================
-- 5. FUNÇÃO: Limpar registos antigos
-- ============================================================

create or replace function public.cleanup_old_rate_limits(
    p_days_to_keep integer default 90
)
returns integer
language plpgsql
as $$
declare
    deleted_count integer;
begin
    DELETE FROM public.api_rate_limits
    WHERE request_date < CURRENT_DATE - (p_days_to_keep || ' days')::interval;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
end;
$$;
