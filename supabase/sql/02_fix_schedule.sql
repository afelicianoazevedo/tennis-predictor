-- ============================================================
-- PATCH: Corrigir generate_daily_schedule()
-- Limita o número de live_polls à quota disponível
-- ============================================================

create or replace function public.generate_daily_schedule()
returns void
language plpgsql
as $$
declare
    first_game timestamptz;
    last_game timestamptz;
    total_games integer;
    morning_hour integer;
    pre_game_window integer;
    poll_interval integer;
    daily_limit integer;
    min_reserved integer;
    current_usage integer;
    remaining integer;
    fixed_requests integer := 0;
    max_polls integer;
    game_duration_minutes integer;
    actual_interval integer;
begin
    -- Obter config
    select cast(value as integer) into morning_hour
    from public.api_config where key = 'morning_sync_hour';

    select cast(value as integer) into pre_game_window
    from public.api_config where key = 'pre_game_window_hours';

    select cast(value as integer) into poll_interval
    from public.api_config where key = 'live_poll_interval_minutes';

    select cast(value as integer) into daily_limit
    from public.api_config where key = 'daily_limit';

    select cast(value as integer) into min_reserved
    from public.api_config where key = 'min_requests_reserved';

    -- Obter quota restante
    current_usage := public.get_api_usage(current_date);
    remaining := daily_limit - current_usage - min_reserved;

    -- Obter janela de jogos de hoje
    select * into first_game, last_game, total_games
    from public.get_today_game_window();

    -- Limpar schedule anterior não executado
    delete from public.sync_schedule
    where scheduled_date = current_date
      and status = 'pending';

    -- 1. Morning sync (1 request)
    insert into public.sync_schedule (scheduled_date, sync_type, scheduled_at, matches_expected)
    values (
        current_date,
        'morning_sync',
        (current_date + (morning_hour || ' hours')::interval),
        0
    );
    fixed_requests := fixed_requests + 1;

    -- Se não há jogos hoje, não precisa de mais schedule
    if total_games = 0 or total_games is null then
        return;
    end if;

    -- 2. Pre-game (1 request, se aplicável)
    if first_game > (current_date + (morning_hour || ' hours')::interval) + interval '3 hours' then
        insert into public.sync_schedule (scheduled_date, sync_type, scheduled_at, matches_expected)
        values (
            current_date,
            'pre_game',
            first_game - (pre_game_window || ' hours')::interval,
            total_games
        );
        fixed_requests := fixed_requests + 1;
    end if;

    -- 3. Post-game (1 request)
    insert into public.sync_schedule (scheduled_date, sync_type, scheduled_at, matches_expected)
    values (
        current_date,
        'post_game',
        last_game + interval '30 minutes',
        total_games
    );
    fixed_requests := fixed_requests + 1;

    -- 4. Calcular quantos polls cabem na quota
    max_polls := remaining - fixed_requests;
    if max_polls < 1 then
        max_polls := 1;
    end if;

    -- Calcular duração total dos jogos em minutos
    game_duration_minutes := extract(epoch from (last_game - first_game)) / 60;
    if game_duration_minutes < 60 then
        game_duration_minutes := 60;
    end if;

    -- Calcular intervalo real para não exceder max_polls
    actual_interval := greatest(
        poll_interval,
        (game_duration_minutes / max_polls)::integer
    );

    -- Gerar live_polls com intervalo ajustado
    insert into public.sync_schedule (scheduled_date, sync_type, scheduled_at, matches_expected)
    select
        current_date,
        'live_poll',
        generate_series(
            first_game,
            last_game + interval '1 hour',
            (actual_interval || ' minutes')::interval
        ),
        total_games;
end;
$$;
