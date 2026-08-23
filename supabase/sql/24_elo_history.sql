-- ============================================================
-- TENNIS PREDICTOR - PLAYER ELO HISTORY
-- ============================================================

-- ============================================================
-- 1. CRIAR TABELA DE HISTÓRICO DE ELO
-- ============================================================

CREATE TABLE IF NOT EXISTS public.player_elo_history (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    player_id bigint NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
    match_id bigint REFERENCES public.matches(id) ON DELETE SET NULL,
    elo_rating numeric NOT NULL,
    elo_change numeric NOT NULL DEFAULT 0,
    surface text,
    surface_elo numeric,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(player_id, match_id)
);

CREATE INDEX IF NOT EXISTS idx_player_elo_history_player_id ON public.player_elo_history(player_id);
CREATE INDEX IF NOT EXISTS idx_player_elo_history_match_id ON public.player_elo_history(match_id);
CREATE INDEX IF NOT EXISTS idx_player_elo_history_created_at ON public.player_elo_history(created_at);


-- ============================================================
-- 2. MODIFICAR recalcular_all_elo PARA GUARDAR HISTÓRICO
-- ============================================================

create or replace function public.recalculate_all_elo()
returns integer
language plpgsql
as $$
declare
    match_record record;
    count integer := 0;
    p1_elo numeric := 1500;
    p2_elo numeric := 1500;
    p1_surface_elo numeric := 1500;
    p2_surface_elo numeric := 1500;
    surface_map text[];
    current_surface text;
    p1_id bigint;
    p2_id bigint;
    p1_won boolean;
    k_factor numeric := 32;
    change_p1 numeric;
    p1_prev_elo numeric;
    p2_prev_elo numeric;
begin
    -- Limpar histórico existente
    DELETE FROM public.player_elo_history;

    for match_record in
        select m.id, m.player1_id, m.player2_id, m.surface, m.status, m.winner_id, m.scheduled_at
        from public.matches m
        where m.status = 'completed'
          and m.winner_id is not null
          and m.player1_id is not null
          and m.player2_id is not null
        order by m.scheduled_at asc, m.id asc
    loop
        p1_id := match_record.player1_id;
        p2_id := match_record.player2_id;
        current_surface := match_record.surface;
        p1_won := (match_record.winner_id = p1_id);

        select coalesce(elo_rating, 1500) into p1_elo from public.players where id = p1_id;
        select coalesce(elo_rating, 1500) into p2_elo from public.players where id = p2_id;

        if p1_elo is null then p1_elo := 1500; end if;
        if p2_elo is null then p2_elo := 1500; end if;

        p1_prev_elo := p1_elo;
        p2_prev_elo := p2_elo;

        change_p1 := public.calculate_elo_change(p1_elo, p2_elo, case when p1_won then 1 else 0 end, k_factor);

        update public.players set
            elo_rating = greatest(100, least(3000, elo_rating + change_p1)),
            elo_updated_at = match_record.scheduled_at
        where id = p1_id;

        update public.players set
            elo_rating = greatest(100, least(3000, elo_rating - change_p1)),
            elo_updated_at = match_record.scheduled_at
        where id = p2_id;

        -- Guardar histórico de Elo global
        insert into public.player_elo_history (player_id, match_id, elo_rating, elo_change, created_at)
        values (p1_id, match_record.id, p1_prev_elo, change_p1, match_record.scheduled_at);

        insert into public.player_elo_history (player_id, match_id, elo_rating, elo_change, created_at)
        values (p2_id, match_record.id, p2_prev_elo, -change_p1, match_record.scheduled_at);

        if current_surface is not null then
            select coalesce(pp.elo_rating, 1500) into p1_surface_elo
            from public.player_performance pp
            where pp.player_id = p1_id and pp.surface = current_surface
            order by pp.period_end desc
            limit 1;

            select coalesce(pp.elo_rating, 1500) into p2_surface_elo
            from public.player_performance pp
            where pp.player_id = p2_id and pp.surface = current_surface
            order by pp.period_end desc
            limit 1;

            if p1_surface_elo is null then p1_surface_elo := 1500; end if;
            if p2_surface_elo is null then p2_surface_elo := 1500; end if;

            update public.player_performance set
                elo_rating = greatest(100, least(3000, coalesce(elo_rating, 1500) + change_p1)),
                updated_at = match_record.scheduled_at
            where player_id = p1_id and surface = current_surface;

            update public.player_performance set
                elo_rating = greatest(100, least(3000, coalesce(elo_rating, 1500) - change_p1)),
                updated_at = match_record.scheduled_at
            where player_id = p2_id and surface = current_surface;

            -- Guardar histórico de Elo de superfície
            insert into public.player_elo_history (player_id, match_id, elo_rating, elo_change, surface, surface_elo, created_at)
            values (p1_id, match_record.id, p1_prev_elo, change_p1, current_surface, p1_surface_elo, match_record.scheduled_at);

            insert into public.player_elo_history (player_id, match_id, elo_rating, elo_change, surface, surface_elo, created_at)
            values (p2_id, match_record.id, p2_prev_elo, -change_p1, current_surface, p2_surface_elo, match_record.scheduled_at);
        end if;

        count := count + 1;
    end loop;

    return count;
end;
$$;


-- ============================================================
-- 3. ATUALIZAR get_player_elo_before PARA USAR HISTÓRICO
-- ============================================================

create or replace function public.get_player_elo_before(
    p_player_id bigint,
    p_before_date timestamptz
)
returns numeric
language plpgsql
as $$
declare
    elo_val numeric;
begin
    select elo_rating into elo_val
    from public.player_elo_history
    where player_id = p_player_id
      and created_at < p_before_date
    order by created_at desc
    limit 1;

    if elo_val is null then
        select coalesce(elo_rating, 1500) into elo_val
        from public.players
        where id = p_player_id;
    end if;

    if elo_val is null then
        elo_val := 1500;
    end if;

    return greatest(100, least(3000, elo_val));
end;
$$;


-- ============================================================
-- 4. FUNÇÃO: Obter Elo de superfície pré-jogo
-- ============================================================

create or replace function public.get_player_surface_elo_before(
    p_player_id bigint,
    p_surface text,
    p_before_date timestamptz
)
returns numeric
language plpgsql
as $$
declare
    elo_val numeric;
begin
    select surface_elo into elo_val
    from public.player_elo_history
    where player_id = p_player_id
      and surface = p_surface
      and created_at < p_before_date
    order by created_at desc
    limit 1;

    if elo_val is null then
        select coalesce(pp.elo_rating, 1500) into elo_val
        from public.player_performance pp
        where pp.player_id = p_player_id and pp.surface = p_surface
        order by pp.period_end desc
        limit 1;
    end if;

    if elo_val is null then
        elo_val := 1500;
    end if;

    return greatest(100, least(3000, elo_val));
end;
$$;
