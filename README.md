# NexusRota Monitor (GitHub Actions)

Alertas operacionais do NexusRota rodando 24/7 no GitHub Actions — funciona com o
notebook do Marcelo desligado. Roda a cada ~5 min (mínimo do GitHub; execuções
podem atrasar sob carga).

## O que faz

- **Monitor operacional** (`scripts/ops-monitor.mjs`) — lê o Supabase (read-only) e
  alerta no Telegram quando algo trava esperando ação:
  1. pedido pago (`report_orders.status='processing'`) → produzir relatório
  2. depósito Pix pendente de confirmação manual
  3. saque a processar
  4. mensagem de cliente sem resposta
- **Monitor de deploys** (`scripts/vercel-monitor.mjs`) — alerta deploys Vercel com
  falha (`ERROR`) nos projetos nexusrota / roteiro-japao-2027 / poatrade.

Cada item só alerta uma vez (dedupe por estado versionado em `state/`).

## Relatório mensal de Analytics

Workflow separado (`.github/workflows/monthly-analytics-report.yml`), roda só no
dia 1 de cada mês (não faz parte do ciclo de 5 em 5 min acima). O script
`scripts/analytics-report.mjs` busca o mês anterior inteiro no Vercel Web
Analytics (projeto `nexusrota`), monta um PDF (`pdfkit`, só tabelas — sem
headless browser) com visão geral, top páginas, países, referrer, dispositivo,
navegador e SO, e envia como documento pro mesmo bot/chat do Telegram. Sem
estado/dedupe — pode rodar de novo manualmente (`workflow_dispatch`) sem
problema, só reenvia o mesmo relatório.

## Segredos (Settings → Secrets and variables → Actions)

| Secret | Descrição |
| --- | --- |
| `SUPABASE_CONN` | Connection string do pooler (role read-only) |
| `VERCEL_TOKEN` | Token da API Vercel |
| `TELEGRAM_BOT_TOKEN` | Token do bot do Telegram |

O `chat_id` (`803022098`) está fixo no workflow.

## Estado

`state/ops.json` e `state/vercel.json` são o dedupe. O próprio workflow faz commit
deles de volta quando algo muda (`[skip ci]`, sem disparar nova execução).
