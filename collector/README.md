# Tennis Collector

Script para recolher jogos de tênis da Live Tennis API e guardar no Supabase.

## Setup

1. Copia `.env.example` para `.env` e preenche com as tuas credenciais do Supabase.
2. Garante que a API key está em `livetennisapi/api.key`.
3. Instala dependências:
   ```bash
   npm install
   ```
4. Corre o script:
   ```bash
   npm start
   ```

## Rate limit

- FREE: 100 pedidos/dia, 30/min.
- O script guarda o estado em `state.json` para não exceder o limite diário.

## Como funciona

1. Consulta `/matches?status=upcoming` e `/matches?status=live`.
2. Guarda/atualiza jogos no Supabase.
3. Para jogos que desapareceram de upcoming/live (podem ter terminado), consulta `/matches/{id}` individualmente para obter o resultado final.

## Agendamento

Podes agendar com `cron` ou Task Scheduler para correr de 30 em 30 minutos.
