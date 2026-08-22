# Tennis Predictor - Sistema de Gestão de Quota

## O que foi adicionado

### 1. Nova tabela: `api_config`
Parâmetros configuráveis sem necessidade de alterar código:

| Key | Default | Descrição |
|-----|---------|-----------|
| `daily_limit` | 90 | Limite operacional de requests/dia |
| `requests_per_hour_during_games` | 6 | Máx. requests/hora durante jogos |
| `morning_sync_hour` | 8 | Hora do sync matinal |
| `pre_game_window_hours` | | Horas antes do 1º jogo para preparar |
| `min_requests_reserved` | 10 | Reserva de segurança final do dia |
| `live_poll_interval_minutes` | 15 | Intervalo de polling |

### 2. Nova tabela: `sync_schedule`
Planeamento automático de sincronizações:

| Campo | Descrição |
|-------|-----------|
| `sync_type` | `morning_sync`, `pre_game`, `live_poll`, `post_game` |
| `scheduled_at` | Quando deve executar |
| `status` | `pending`, `in_progress`, `completed`, `failed` |

### 3. Funções novas/atualizadas

| Função | Descrição |
|--------|-----------|
| `can_make_api_request()` | **Melhorada** — agora verifica quota diária + distribuição horária |
| `get_remaining_requests()` | Requests restantes no dia |
| `get_hourly_usage()` | Requests usados na hora atual |
| `get_today_game_window()` | Primeiro/último jogo do dia |
| `generate_daily_schedule()` | Cria agenda automática baseada nos jogos |
| `get_next_sync()` | Próximo sync pendente |
| `get_daily_stats()` | Estatísticas completas do dia |

## Como executar

### Passo 1: Executar SQL no Supabase

1. Ir a: https://supabase.com/dashboard/project/ywmrxvurnxgnmpcjnisi/sql/new
2. Abrir ficheiro: `supabase/sql/01_api_quota_system.sql`
3. Copiar e colar no SQL Editor
4. Executar (Ctrl+Enter ou botão "Run")

### Passo 2: Testar

```bash
cd supabase/functions/update-tennis-data
deno run --allow-net --allow-env --allow-read test/sync-test.ts morning
```

## Fluxo de funcionamento

```
08:00  → morning_sync (busca jogos dos próximos 3 dias)
       → generate_daily_schedule() (cria agenda)

13:00  → pre_game (se há jogos às 15:00)
       → Completa dados de torneios/jogadores em falta

15:00  → live_poll (a cada 15 min)
       → Atualiza resultados dos jogos em curso
       → Máximo 6 requests/hora

22:00  → post_game (após último jogo)
       → Atualiza resultados finais
```

## Distribuição de quota (exemplo para 12h de jogos)

| Período | Cálculo | Requests |
|---------|---------|----------|
| Manhã | 1 sync | ~3-5 |
| Pré-jogo | 1 sync | ~3-5 |
| Jogos (12h) | 6/h × 12h | 72 |
| **Total** | | **~80-82** |
| Reserva | | ~8-10 |
| **Limite** | | **90** |
