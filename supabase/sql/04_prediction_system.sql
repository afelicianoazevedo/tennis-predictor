-- ============================================================
-- SISTEMA DE PREVISÃO
-- ============================================================

-- ============================================================
-- 1. FUNÇÃO: Calcular previsão para um jogo
-- Baseado na diferença de ranking entre jogadores
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
    p1_ranking integer;
    p2_ranking integer;
    p1_points numeric;
    p2_points numeric;
    rank_diff numeric;
    total_rank numeric;
    p1_prob numeric;
    p2_prob numeric;
    conf_score numeric;
    conf_level text;
    winner_id bigint;
    p1_id bigint;
    p2_id bigint;
begin
    -- Obter dados dos jogadores
    select m.player1_id, m.player2_id, p1.ranking, p2.ranking, p1.ranking_points, p2.ranking_points
    into p1_id, p2_id, p1_ranking, p2_ranking, p1_points, p2_points
    from public.matches m
    left join public.players p1 on p1.id = m.player1_id
    left join public.players p2 on p2.id = m.player2_id
    where m.id = p_match_id;

    -- Se não há dados de ranking suficientes
    if p1_ranking is null and p2_ranking is null then
        return query select 50.0::numeric, 50.0::numeric, 10.0::numeric, 'incerto'::text, null::bigint;
        return;
    end if;

    -- Tratar rankings nulos (jogador sem ranking = pior que qualquer ranked)
    if p1_ranking is null then p1_ranking = 2000; end if;
    if p2_ranking is null then p2_ranking = 2000; end if;

    -- Calcular probabilidades baseadas no ranking
    -- Fórmula: prob = (1 / ranking) / (1/r1 + 1/r2)
    p1_prob = (1.0 / p1_ranking) / (1.0 / p1_ranking + 1.0 / p2_ranking);
    p2_prob = 1.0 - p1_prob;

    -- Converter para percentagem
    p1_prob = round(p1_prob * 100, 2);
    p2_prob = round(p2_prob * 100, 2);

    -- Calcular confiança baseada na diferença de ranking
    rank_diff = abs(p1_ranking - p2_ranking)::numeric;
    total_rank = (p1_ranking + p2_ranking)::numeric;

    -- Confiança: maior diferença = maior confiança
    conf_score = least(95, greatest(10, (rank_diff / total_rank) * 200 + 30));

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
        'v1_ranking',
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
        predicted_winner_id = pred.predicted_winner_id
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
        select m.id
        from public.matches m
        left join public.match_predictions mp on mp.match_id = m.id
        where mp.id is null
          and m.status in ('upcoming', 'live')
          and m.player1_id is not null
          and m.player2_id is not null
    loop
        perform public.generate_prediction(match_record.id);
        count := count + 1;
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
-- 5. TRIGGER: Atualizar was_correct quando resultado é conhecido
-- ============================================================

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
