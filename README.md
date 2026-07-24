# financas-dashboard

Dashboard de gastos e receitas pessoais. Substitui a planilha do Google Sheets
+ Apps Script: um bot em Node grava direto num banco (Prisma) e o dashboard
em Next.js mostra tudo com filtros, forma de pagamento, gastos fixos, gráfico
por categoria, maiores gastos, exportação CSV e edição/exclusão de registros.

**Já está no ar:** https://financas-dashboard-omega.vercel.app
Banco: Neon Postgres (projeto `financas-dashboard`, região São Paulo).
Bot: webhook em produção (não depende de nenhum processo/computador ligado).
Repo: https://github.com/zerkjesz/financas-dashboard (privado)

Pra atualizar o site depois de mexer no código: só dar `git push` na branch
`main` — a Vercel já está conectada ao repositório e faz o deploy sozinha a
cada push.

## Como funciona

1. Você manda uma mensagem de texto livre pro bot no Telegram, tipo
   `"50 mercado pix"`, `"aluguel 1200 fixo cartao"` ou `"recebi 200 freela"`.
2. O bot interpreta valor, tipo (gasto/receita), categoria, forma de
   pagamento (Pix / Cartão de Crédito / Vale Alimentação) e se é recorrente —
   tudo por palavra-chave, salvo direto no banco.
3. O dashboard mostra a lista, resumo, gráfico de gastos por categoria,
   maiores gastos do período, e permite editar categoria/pagamento, buscar,
   filtrar, excluir registro(s) ou apagar tudo.

## Setup local

```bash
npm install
cp .env.example .env
npx prisma migrate dev --name init
```

### 1. Desligar o Apps Script antigo

O bot antigo (Apps Script) e o bot novo (Node) **não podem rodar ao mesmo
tempo** — só um consegue processar as mensagens do Telegram por vez.

1. Na planilha antiga: **Extensões → Apps Script**.
2. Ícone de **relógio (Acionadores)** na barra lateral.
3. Ache o acionador ligado à função que recebe o Telegram (tipo `doPost`) →
   **3 pontinhos → Excluir acionador**.

O bot novo já chama `deleteWebHook()` sozinho ao iniciar, então mesmo que
sobre uma configuração antiga ele assume o controle — mas o ideal é desligar
o Apps Script mesmo, pra não ter os dois competindo.

### 2. Configurar o token

Mesmo bot do Telegram de sempre: fale com [@BotFather](https://t.me/BotFather),
`/mybots` → escolha o bot → **API Token** (reexibe o token existente, não
precisa criar um novo). Cole em `TELEGRAM_TOKEN` no `.env`.

### 3. Rodar

Em dois terminais separados:

```bash
npm run dev   # dashboard em http://localhost:3001
npm run bot   # bot do Telegram (fica escutando mensagens)
```

Rodando local assim, o computador precisa ficar ligado com os dois terminais
abertos. Pra não depender disso, veja "Hospedar" abaixo.

## Formas de pagamento reconhecidas

| Forma | Palavras que o bot entende |
|---|---|
| Pix | `pix` |
| Cartão de Crédito | `cartao`, `cartão`, `credito`, `crédito` |
| Vale Alimentação | `vale`, `vale alimentacao`, `va`, `vr` |

Gasto fixo/recorrente: `fixo`, `fixa`, `recorrente`, `assinatura`, `mensal`,
`mensalidade` — marca o registro com 🔁 (editável manualmente no dashboard
também).

## Hospedagem (já configurada)

- **Banco**: Neon Postgres, projeto `financas-dashboard`, região São Paulo.
  Connection string está nas env vars da Vercel (`DATABASE_URL`).
- **Deploy**: Vercel, projeto `zerkjeszs-projects/financas-dashboard`,
  conectado ao repositório GitHub — todo `git push` na `main` dispara deploy
  automático.
- **Bot**: webhook (`app/api/telegram/webhook/route.js`) configurado direto
  na API do Telegram, apontando pro domínio da Vercel. Não depende de
  `npm run bot` nem de nenhum computador ligado.

Se precisar reconfigurar o webhook (ex: mudou o domínio):
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://SEU_DOMINIO.vercel.app/api/telegram/webhook"
```

Pra conferir o status do webhook:
```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

## Estrutura

- `prisma/schema.prisma` — modelo `Transaction`
- `lib/parseTransaction.js` — interpreta a mensagem de texto livre (valor, tipo, categoria, pagamento, recorrência)
- `lib/processTelegramMessage.js` — lógica compartilhada entre o bot local e o webhook hospedado
- `bot/telegram-bot.js` — bot local (polling), usado em dev
- `app/api/telegram/webhook/route.js` — bot hospedado (webhook), usado em produção
- `app/` — dashboard (Next.js App Router)
- `app/api/transactions/` — API REST usada pelo dashboard (GET/POST/PATCH/DELETE)

## Próximos passos possíveis

- Categorização mais esperta (hoje é por palavra-chave simples).
- Meta/limite de gasto por categoria com aviso.
- Auto-lançamento de gastos fixos todo mês (via Vercel Cron).
