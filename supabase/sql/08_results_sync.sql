-- ============================================================
-- SINCRONIZAÇÃO DE RESULTADOS - SportScore API
-- ============================================================

-- ============================================================
-- 1. FUNÇÃO: Atualizar resultado de um jogo
-- ============================================================

create or replace function public.update_match_result(
    p_match_id bigint,
    p_home_score integer,
    p_away_score integer,
    p_status text
)
returns void
language plpgsql
as $$
declare
    v_winner_id bigint;
    v_player1_id bigint;
    v_player2_id bigint;
    v_match_status text;
begin
    -- Obter dados do jogo
    select m.player1_id, m.player2_id, m.status
    into v_player1_id, v_player2_id, v_match_status
    from public.matches m
    where m.id = p_match_id;

    if v_player1_id is null or v_player2_id is null then
        return;
    end if;

    -- Determinar vencedor baseado no score (apenas para jogos terminados)
    if p_status = 'finished' then
        if p_home_score > p_away_score then
            v_winner_id := v_player1_id;
        elsif p_away_score > p_home_score then
            v_winner_id := v_player2_id;
        else
            v_winner_id := null;
        end if;
    else
        v_winner_id := null; -- Jogo ao vivo não tem vencedor ainda
    end if;

    -- Atualizar jogo com resultado
    update public.matches set
        score = p_home_score || '-' || p_away_score,
        winner_id = v_winner_id,
        status = case
            when p_status = 'finished' then 'completed'
            when p_status = 'live' then 'live'
            else status
        end,
        updated_at = now()
    where id = p_match_id;
end;
$$;


-- ============================================================
-- 2. FUNÇÃO: Encontrar jogo por data e nomes dos jogadores
-- ============================================================

create or replace function public.find_match_by_date_and_players(
    p_match_date date,
    p_player1_name text,
    p_player2_name text
)
returns bigint
language plpgsql
as $$
declare
    v_match_id bigint;
    v_normalized_date date;
begin
    -- Tentativa 1:匹配 exato dos nomes em qualquer ordem
    select m.id into v_match_id
    from public.matches m
    join public.players p1 on p1.id = m.player1_id
    join public.players p2 on p2.id = m.player2_id
    where m.scheduled_at::date = p_match_date
      and (
          (p1.name = p_player1_name and p2.name = p_player2_name)
          or (p1.name = p_player2_name and p2.name = p_player1_name)
      )
    limit 1;

    if v_match_id is not null then
        return v_match_id;
    end if;

    -- Tentativa 2:匹配 parcial (sobrenome)
    select m.id into v_match_id
    from public.matches m
    join public.players p1 on p1.id = m.player1_id
    join public.players p2 on p2.id = m.player2_id
    where m.scheduled_at::date = p_match_date
      and (
          (p1.name ilike '%' || split_part(p_player1_name, ' ', array_length(string_to_array(p_player1_name, ' '), 1)) || '%'
           and p2.name ilike '%' || split_part(p_player2_name, ' ', array_length(string_to_array(p_player2_name, ' '), 1)) || '%')
          or (p1.name ilike '%' || split_part(p_player2_name, ' ', array_length(string_to_array(p_player2_name, ' '), 1)) || '%'
              and p2.name ilike '%' || split_part(p_player1_name, ' ', array_length(string_to_array(p_player1_name, ' '), 1)) || '%')
      )
    limit 1;

    return v_match_id;
end;
$$;


-- ============================================================
-- 3. FUNÇÃO: Processar resultados do SportScore
-- ============================================================

create or replace function public.process_sportscore_results(p_date date)
returns table (
    matches_updated integer,
    matches_not_found integer,
    errors text
)
language plpgsql
as $$
declare
    v_api_url text;
    v_response json;
    v_matches json;
    v_match json;
    v_match_id bigint;
    v_home_name text;
    v_away_name text;
    v_home_score integer;
    v_away_score integer;
    v_status text;
    v_updated integer := 0;
    v_not_found integer := 0;
    v_errors text := '';
begin
    -- Construir URL da API
    v_api_url := 'https://sportscore.com/api/widget/matches/?sport=tennis&limit=200';

    -- Note: This function is called from Edge Function which handles the actual HTTP request
    -- This is a placeholder for the SQL-only operations
    
    return query select v_updated, v_not_found, v_errors;
end;
$$;


-- ============================================================
-- 4. ADICIONAR COLUNA last_results_sync à api_config
-- ============================================================

-- Verificar se a coluna existe antes de adicionar
do $$
begin
    if not exists (select 1 from information_schema.columns 
                   where table_name = 'api_config' and column_name = 'description') then
        alter table public.api_config add column description text;
    end if;
end $$;

-- Inserir configuração da SportScore API
insert INTO public.api_config (key, value, description) VALUES
    ('sportscore_base_url', 'https://sportscore.com/api/widget/matches/', 'URL base da SportScore API'),
    ('sportscore_enabled', 'true', 'Se a sincronização de resultados está ativa'),
    ('results_sync_hour', '23', 'Hora para sincronizar resultados (24h format)')
ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    description = EXCLUDED.description,
    updated_at = now();
