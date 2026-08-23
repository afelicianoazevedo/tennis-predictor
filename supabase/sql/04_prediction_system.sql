-- ============================================================
-- SISTEMA DE PREVISÃO
-- ============================================================

-- ============================================================
-- 1. FUNÇÃO: Calcular previsão para um jogo
-- Baseado em Elo com fallback para ranking
-- ============================================================

create or replace function public.calculate_match_prediction(p_match_id bigint)
returns table (
    player1_probability numeric,
    player2_probability numeric,
    confidence_score numeric,
    confidence_level text,
    predicted_winner_id bigint
)
language plpgsql
as $$
declare
    p1_elo numeric;
    p2_elo numeric;
    p1_ranking integer;
    p2_ranking integer;
    p1_points numeric;
    p2_points numeric;
    elo_diff numeric;
    p1_prob numeric;
    p2_prob numeric;
    conf_score numeric;
    conf_level text;
    winner_id bigint;
    p1_id bigint;
    p2_id bigint;
    use_elo boolean := false;
begin
    -- Obter dados dos jogadores
    select m.player1_id, m.player2_id, p1.ranking, p2.ranking, p1.ranking_points, p2.ranking_points
    into p1_id, p2_id, p1_ranking, p2_ranking, p1_points, p2_points
    from public.matches m
    left join public.players p1 on p1.id = m.player1_id
    left join public.players p2 on p2.id = m.player2_id
    where m.id = p_match_id;

    -- Tentar usar Elo se disponível
    select coalesce(p1.elo_rating, 1500) into p1_elo from public.players p1 where p1.id = p1_id;
    select coalesce(p2.elo_rating, 1500) into p2_elo from public.players p2 where p2.id = p2_id;

    IF p1_elo IS NOT NULL AND p2_elo IS NOT NULL AND (p1_elo != 1500 OR p2_elo != 1500) THEN
        use_elo := true;
    END IF;

    -- Se não há dados suficientes
    if not use_elo and p1_ranking is null and p2_ranking is null then
        return query select 50.0::numeric, 50.0::numeric, 10.0::numeric, 'incerto'::text, null::bigint;
        return;
    end if;

    IF use_elo THEN
        -- Calcular probabilidades baseadas no Elo
        elo_diff := p1_elo - p2_elo;
        p1_prob := 1.0 / (1.0 + power(10, -elo_diff / 400.0));
        p2_prob := 1.0 - p1_prob;

        -- Converter para percentagem
        p1_prob := round(p1_prob * 100, 2);
        p2_prob := round(p2_prob * 100, 2);

        -- Calcular confiança baseada na diferença de Elo
        conf_score := least(95, greatest(10, (abs(elo_diff) / 400.0) * 100 + 20));
        conf_score := round(conf_score, 0);
    ELSE
        -- Fallback para ranking se Elo não disponível
        if p1_ranking is null then p1_ranking = 2000; end if;
        if p2_ranking is null then p2_ranking = 2000; end if;

        p1_prob = (1.0 / p1_ranking) / (1.0 / p1_ranking + 1.0 / p2_ranking);
        p2_prob = 1.0 - p1_prob;

        p1_prob = round(p1_prob * 100, 0);
        p2_prob = round(p2_prob * 100, 0);

        conf_score = least(95, greatest(10, (abs(p1_ranking - p2_ranking)::numeric / (p1_ranking + p2_ranking)::numeric) * 200 + 30));
        conf_score = round(conf_score, 0);
    END IF;

    -- Determinar nível de confiança
    if conf_score < 50 then
        conf_level := 'incerto';
    elsif conf_score < 60 then
        conf_level := 'perigoso';
    elsif conf_score < 70 then
        conf_level := 'tendencia';
    else
        conf_level := 'forte';
    end if;

    -- Determinar vencedor previsto
    if p1_prob > p2_prob then
        winner_id := p1_id;
    elsif p2_prob > p1_prob then
        winner_id := p2_id;
    else
        winner_id := null;
    end if;

    return query select p1_prob, p2_prob, conf_score, conf_level, winner_id;
end;
$$;


-- ============================================================
-- 2. FUNÇÃO: Gerar previsão e guardar na BD
-- ============================================================

create or replace function public.generate_prediction(p_match_id bigint)
returns bigint
language plpgsql
as $$
declare
    pred record;
    pred_id bigint;
begin
    -- Calcular previsão
    select * into pred from public.calculate_match_prediction(p_match_id);

    -- Inserir ou atualizar previsão
    insert into public.match_predictions (
        match_id,
        player1_probability,
        player2_probability,
        confidence_score,
        confidence_level,
        predicted_winner_id,
        model_version,
        created_at
    ) values (
        p_match_id,
        pred.player1_probability,
        pred.player2_probability,
        pred.confidence_score,
        pred.confidence_level,
        pred.predicted_winner_id,
        'v2_elo',
        now()
    )
    on conflict (match_id) do update set
        player1_probability = excluded.player1_probability,
        player2_probability = excluded.player2_probability,
        confidence_score = excluded.confidence_score,
        confidence_level = excluded.confidence_level,
        predicted_winner_id = excluded.predicted_winner_id,
        model_version = excluded.model_version,
        created_at = now()
    returning id into pred_id;

    -- Atualizar match com dados da previsão
    update public.matches set
        confidence_score = pred.confidence_score,
        confidence_level = pred.confidence_level,
        predicted_winner_id = pred.predicted_winner_id,
        player1_probability = pred.player1_probability,
        player2_probability = pred.player2_probability
    where id = p_match_id;

    return pred_id;
end;
$$;


-- ============================================================
-- 3. FUNÇÃO: Gerar previsões para todos os jogos sem previsão
-- ============================================================

create or replace function public.generate_all_predictions()
returns integer
language plpgsql
as $$
declare
    match_record record;
    count integer := 0;
begin
    for match_record in
        select m.id, m.status, m.winner_id
        from public.matches m
        left join public.match_predictions mp on mp.match_id = m.id
        where mp.id is null
          and m.status in ('upcoming', 'live', 'completed')
          and m.player1_id is not null
          and m.player2_id is not null
    loop
        perform public.generate_prediction(match_record.id);
        count := count + 1;

        if match_record.status = 'completed' and match_record.winner_id is not null then
            update public.match_predictions set
                was_correct = (predicted_winner_id = match_record.winner_id),
                result = case when predicted_winner_id = match_record.winner_id then 'correct' else 'incorrect' end
            where match_id = match_record.id;
        end if;
    end loop;

    return count;
end;
$$;


-- ============================================================
-- 4. FUNÇÃO: Verificar acurácia das previsões
-- ============================================================

create or replace function public.evaluate_predictions()
returns table (
    total_predictions integer,
    correct_predictions integer,
    accuracy numeric
)
language sql
as $$
    select
        count(*)::integer,
        count(*) filter (where was_correct = true)::integer,
        round(count(*) filter (where was_correct = true)::numeric / nullif(count(*), 0) * 100, 2)
    from public.match_predictions
    where result is not null;
$$;


-- ============================================================
-- 6. FUNÇÃO: Regenerar previsões para jogos live e upcoming
-- ============================================================

create or replace function public.regenerate_predictions_for_live_upcoming()
returns integer
language plpgsql
as $$
declare
    match_record record;
    count integer := 0;
begin
    FOR match_record IN
        SELECT m.id
        FROM public.matches m
        WHERE m.status IN ('live', 'upcoming')
          AND m.player1_id IS NOT NULL
          AND m.player2_id IS NOT NULL
    LOOP
        PERFORM public.generate_prediction(match_record.id);
        count := count + 1;
    END LOOP;

    RETURN count;
end;
$$;


-- ============================================================
-- 7. TRIGGER: Atualizar was_correct quando resultado é conhecido
-- ============================================================

DROP TRIGGER IF EXISTS trg_check_prediction ON public.matches;

create or replace function public.check_prediction_result()
returns trigger
language plpgsql
as $$
declare
    winner_id bigint;
begin
    -- Obter vencedor do jogo
    select m.winner_id into winner_id
    from public.matches m
    where m.id = new.match_id;

    -- Se o jogo tem resultado
    if winner_id is not null then
        update public.match_predictions set
            was_correct = (predicted_winner_id = winner_id),
            result = case when predicted_winner_id = winner_id then 'correct' else 'incorrect' end
        where match_id = new.match_id;
    end if;

    return new;
end;
$$;

create trigger trg_check_prediction
    after update of winner_id on public.matches
    for each row
    when (new.winner_id is not null)
    execute function public.check_prediction_result();
