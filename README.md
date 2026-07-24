# financas-dashboard

Dashboard de gastos e receitas pessoais. Substitui a planilha do Google Sheets
+ Apps Script: um bot em Node grava direto num banco (Prisma) e o dashboard
em Next.js mostra tudo com filtros, forma de pagamento, gastos fixos, gráfico
por categoria, maiores gastos, exportação CSV e edição/exclusão de registros.

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

## Hospedar (sempre ativo, em qualquer dispositivo)

Pra não depender do Mac ligado e acessar de PC/celular/qualquer lugar:

1. **Banco na nuvem**: crie um banco Postgres grátis (Neon ou Supabase — o
   zerk-ecommerce já usa Neon, dá pra reaproveitar a conta). Troque no
   `prisma/schema.prisma` o `provider` de `sqlite` pra `postgresql` e coloque
   a connection string no `DATABASE_URL`. Rode `npx prisma migrate deploy`.
2. **Deploy do dashboard**: suba o projeto num repositório Git e importe na
   [Vercel](https://vercel.com) (login com GitHub, plano grátis). Configure a
   env var `DATABASE_URL` e `TELEGRAM_TOKEN` lá nas configurações do projeto.
3. **Bot vira webhook** (não precisa mais de `npm run bot` rodando): depois
   do deploy, chame uma vez (trocando pelos seus valores):
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://SEU_DOMINIO.vercel.app/api/telegram/webhook"
   ```
   A partir daí o Telegram chama `app/api/telegram/webhook/route.js`
   diretamente a cada mensagem — sem processo nenhum rodando 24h.

Depois disso o dashboard fica acessível em qualquer navegador (PC, Mac,
celular) pela URL da Vercel, e o bot funciona sempre, mesmo com o Mac
desligado.

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
