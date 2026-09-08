# Fase 5.3C — Manifesto de configuração de produção (NÃO executado)

Lista do que precisa ser configurado na Vercel (Project Settings → Environment
Variables → Production) antes de qualquer deploy real. **Nenhum valor real
aparece aqui** — nomes e propósito apenas. Nenhuma dessas variáveis foi
configurada em produção nesta fase; produção continua intocada.

| Env var | Propósito | Obrigatória? | É segredo? | Onde é consumida |
|---|---|---|---|---|
| `SESSION_SECRET` | Assina o token de sessão web (HMAC-SHA256) | Sim, em produção (fail closed sem ela) | Sim | `lib/auth/session.js`, `middleware.js`, rotas `app/api/auth/**` |
| `DASHBOARD_PASSWORD_HASH` | Hash scrypt da senha do dashboard (formato `scrypt:N:r:p:saltHex:hashHex`, gerado por `scripts/generate-password-hash.mjs`) | Sim, em produção | Sim (é um hash, não a senha, mas trate como segredo) | `lib/auth/password.js`, `app/api/auth/login/route.js` |
| `TELEGRAM_WEBHOOK_SECRET` | Validado contra o header `X-Telegram-Bot-Api-Secret-Token` — prova que o POST veio do Telegram de verdade | Sim, em produção, se o webhook (não o bot local) for usado | Sim | `app/api/telegram/webhook/route.js` |
| `TELEGRAM_ALLOWED_USER_ID` | from.id (identidade do usuário, não chat.id — ver Fase 5.3C.1) do único usuário autorizado a interagir com o bot | Sim, em produção | Não é segredo por si (é um ID), mas não deve ser público | `lib/telegramUpdateHandler.js` (compartilhado por webhook + `bot/telegram-bot.js`) |
| `AUTH_DEV_BYPASS` | Desliga toda a proteção (web + Telegram) — SÓ dev local | Nunca em produção (o código recusa mesmo se setada) | N/A | `lib/auth/envConfig.js` |
| `TELEGRAM_TOKEN` | Token do bot (já existia antes desta fase) | Sim | Sim | `bot/telegram-bot.js`, `lib/telegramApi.js` |
| `DATABASE_URL` / `DIRECT_URL` | Conexão com o Postgres/Neon (já existiam antes desta fase) | Sim | Sim | `lib/prisma.js`, migrations |

## Passos de configuração (quando for a hora — não executado nesta fase)

1. Gerar `SESSION_SECRET`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Gerar `DASHBOARD_PASSWORD_HASH`: `node scripts/generate-password-hash.mjs "senha real escolhida"` — colar a saída, nunca a senha em si.
3. Gerar `TELEGRAM_WEBHOOK_SECRET`: qualquer string aleatória longa (ex: mesmo comando do passo 1 com menos bytes).
4. Descobrir `TELEGRAM_ALLOWED_USER_ID`: mandar qualquer mensagem pro bot uma vez e olhar o campo `message.from.id` do update recebido (nunca `chat.id` — ver Fase 5.3C.1) — ou usar um bot utilitário tipo @userinfobot.
5. Configurar as 4 variáveis acima na Vercel, ambiente Production (e Preview, se for testar lá).
6. Depois do deploy: `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://SEU_DOMINIO/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"`.

Nenhum desses passos foi executado nesta fase — produção e Vercel continuam
intocadas.
