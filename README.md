# Tennis Predictor

Aplicação web progressiva (PWA) para análise e previsão de jogos de ténis.

## Stack

- **Frontend**: HTML5 + CSS3 + JavaScript (sem frameworks pesados)
- **Backend**: Supabase Edge Functions
- **Base de dados**: Supabase PostgreSQL
- **Fonte de dados**: Live Tennis API

## Estrutura

```
tennis-predictor/
├── supabase/
│   ├── config.toml
│   └── functions/
│       └── update-tennis-data/
│           ├── index.ts          # Edge Function principal
│           ├── deno.json
│           ├── lib/
│           │   ├── api-client.ts # Cliente HTTP para Live Tennis API
│           │   ├── db.ts         # Operações na BD (upsert)
│           │   ├── quota.ts      # Gestão de quota da API
│           │   └── types.ts      # Definições de tipos
│           └── test/
│               └── sync-test.ts  # Teste manual de sincronização
├── src/
│   ├── css/
│   └── js/
├── public/
├── .env.example
├── .gitignore
└── README.md
```

## Configuração

1. Copiar `.env.example` para `.env`
2. Preencher as variáveis com os valores do Supabase e da Live Tennis API

```bash
cp .env.example .env
```

## Desenvolvimento

### Supabase CLI

Iniciar o Supabase localmente:

```bash
supabase start
```

Deploy da Edge Function:

```bast
supabase functions deploy update-tennis-data
```

### Teste manual da sincronização

Executar o script de teste (necessita Deno):

```bash
cd supabase/functions/update-tennis-data
deno run --allow-net --allow-env --allow-read test/sync-test.ts [dias]
```

O argumento `dias` (opcional, default=3) define quantos dias à frente pesquisar.

### Testar a Edge Function localmente

```bash
supabase functions serve update-tennis-data --env-file ../../.env
```

Depois fazer pedido HTTP:

```bash
curl "http://localhost:54321/functions/v1/update-tennis-data?days=3"
```

## API Quota

- Limite FREE: 100 requests/dia
- Limite operacional: 90 requests/dia (margem de segurança de 10)
- Rate limit: 30 requests/minuto

## Base de dados

As 7 tabelas já existem no Supabase:

- `players` — Jogadores
- `tournaments` — Torneios
- `matches` — Jogos
- `match_predictions` — Previsões
- `odds` — Odds de mercado
- `api_usage` — Controlo diário de quota
- `api_requests` — Log de todos os pedidos à API
