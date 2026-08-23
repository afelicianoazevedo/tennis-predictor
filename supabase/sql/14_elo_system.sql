-- ============================================================
-- TENNIS PREDICTOR - ELo SYSTEM
-- ============================================================

-- ============================================================
-- 1. ADICIONAR COLUNAS DE ELO À TABELA PLAYERS
-- ============================================================

ALTER TABLE public.players
    ADD COLUMN IF NOT EXISTS elo_rating numeric(8,2) DEFAULT 1500,
    ADD COLUMN IF NOT EXISTS elo_updated_at timestamptz;

-- ============================================================
-- 2. FUNÇÃO: Calcular mudança de Elo
-- ============================================================

create or replace function public.calculate_elo_change(
    p_rating_a numeric,
    p_rating_b numeric,
    p_result_a numeric,  -- 1 = vitória, 0 = derrota, 0.5 = empate
    p_k_factor numeric default 32
)
returns numeric
language plpgsql
as $$
declare
    expected_a numeric;
    change_a numeric;
begin
    expected_a := 1.0 / (1.0 + power(10, (p_rating_b - p_rating_a) / 400.0));
    change_a := p_k_factor * (p_result_a - expected_a);
    return round(change_a, 2);
end;
$$;


-- ============================================================
-- 3. FUNÇÃO: Atualizar Elo após um jogo
-- ============================================================

create or replace function public.update_elo_after_match(
    p_match_id bigint
)
returns void
language plpgsql
as $$
declare
    match_record record;
    p1_id bigint;
    p2_id bigint;
    p1_elo numeric;
    p2_elo numeric;
    p1_surface_elo numeric;
    p2_surface_elo numeric;
    p1_won boolean;
    surface text;
    k_factor numeric := 32;
    change_p1 numeric;
    change_p2 numeric;
begin
    select m.player1_id, m.player2_id, m.surface, m.status, m.winner_id
    into match_record
    from public.matches m
    where m.id = p_match_id;

    if match_record.status != 'completed' or match_record.winner_id is null then
        return;
    end if;

    p1_id := match_record.player1_id;
    p2_id := match_record.player2_id;
    surface := match_record.surface;
    p1_won := (match_record.winner_id = p1_id);

    select elo_rating into p1_elo from public.players where id = p1_id;
    select elo_rating into p2_elo from public.players where id = p2_id;

    if p1_elo is null then p1_elo := 1500; end if;
    if p2_elo is null then p2_elo := 1500; end if;

    change_p1 := public.calculate_elo_change(p1_elo, p2_elo, case when p1_won then 1 else 0 end, k_factor);
    change_p2 := -change_p1;

    update public.players set
        elo_rating = greatest(100, least(3000, elo_rating + change_p1)),
        elo_updated_at = now()
    where id = p1_id;

    update public.players set
        elo_rating = greatest(100, least(3000, elo_rating + change_p2)),
        elo_updated_at = now()
    where id = p2_id;

    if surface is not null then
        select coalesce(pp.elo_rating, 1500) into p1_surface_elo
        from public.player_performance pp
        where pp.player_id = p1_id and pp.surface = surface
        order by pp.period_end desc
        limit 1;

        select coalesce(pp.elo_rating, 1500) into p2_surface_elo
        from public.player_performance pp
        where pp.player_id = p2_id and pp.surface = surface
        order by pp.period_end desc
        limit 1;

        if p1_surface_elo is null then p1_surface_elo := 1500; end if;
        if p2_surface_elo is null then p2_surface_elo := 1500; end if;

        update public.player_performance set
            elo_rating = greatest(100, least(3000, coalesce(elo_rating, 1500) + 
                case when p1_id = player_id then change_p1 else 0 end)),
            updated_at = now()
        where player_id = p1_id and surface = surface;

        update public.player_performance set
            elo_rating = greatest(100, least(3000, coalesce(elo_rating, 1500) + 
                case when p2_id = player_id then change_p2 else 0 end)),
            updated_at = now()
        where player_id = p2_id and surface = surface;
    end if;
end;
$$;


-- ============================================================
-- 4. FUNÇÃO: Obter Elo pré-jogo (sem data leakage)
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
    from public.players
    where id = p_player_id
      and elo_updated_at is not null
      and elo_updated_at < p_before_date;

    if elo_val is null then
        elo_val := 1500;
    end if;

    return greatest(100, least(3000, elo_val));
end;
$$;


-- ============================================================
-- 5. FUNÇÃO: Recalcular Elo histórico
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
begin
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

        change_p1 := public.calculate_elo_change(p1_elo, p2_elo, case when p1_won then 1 else 0 end, k_factor);

        update public.players set
            elo_rating = greatest(100, least(3000, elo_rating + change_p1)),
            elo_updated_at = match_record.scheduled_at
        where id = p1_id;

        update public.players set
            elo_rating = greatest(100, least(3000, elo_rating - change_p1)),
            elo_updated_at = match_record.scheduled_at
        where id = p2_id;

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
        end if;

        count := count + 1;
    end loop;

    return count;
end;
$$;
