# Fase 5.5.2 — Contenção de exposição de privacidade em produção

Documento de incidente. **Sem valores financeiros, sem dados pessoais, sem
segredos.**

## SECURITY_FINDING

O deployment de produção legado (`https://financas-dashboard-omega.vercel.app`)
estava acessível **anonimamente**:

- `GET /` → HTTP 200, dashboard renderizado, sem autenticação.
- `GET /api/dashboard` → HTTP 200, **payload financeiro completo em JSON**,
  sem autenticação.
- `GET /login` → HTTP 404 (a página de login não existe nesse deployment).

## DATA_CONTENT

Payload financeiro do produto (saldos de conta, uso de cartão, obrigações,
lançamentos). Nenhum valor é reproduzido aqui.

## ROOT_CAUSE

Produção roda **código pré-autenticação (pré-V2)**. `origin/main` está 61
commits atrás do branch local. Toda a camada de autenticação
(`middleware.js` + `lib/auth/**`, introduzida na Fase 5.3C) e toda a
arquitetura V2 (Fases 5.1–5.5) nunca foram deployadas. O deployment ativo é
o app como estava por volta do fim de agosto/2026 — quando ainda não havia
auth nenhuma. Isto não foi introduzido pelas Fases 5.5.x; foi descoberto por
elas.

## CONTAINMENT (executado na Fase 5.5.2)

Habilitado **Vercel Deployment Protection / Vercel Authentication** para
**todos os deployments** do projeto, via API da Vercel:

```
PATCH /v9/projects/{projectId}   { "ssoProtection": { "deploymentType": "all" } }
```

(antes: `{"deploymentType":"all_except_custom_domains"}` — que **não**
protegia o domínio de produção `*.vercel.app`).

### Verificação pós-contenção (anônima, sem autenticar, sem ler payload)

| Requisição | Antes | Depois |
|---|---|---|
| `GET /` | 200 (dashboard) | **302 → `vercel.com/sso-api` → `vercel.com/login`** |
| `GET /api/dashboard` | 200 (JSON financeiro, ~37 KB) | **302, body "Redirecting..." (15 B)** |
| `POST /api/telegram/webhook` | (processado pelo código antigo) | **401** |

`PRODUCTION_PRIVACY_CONTAINED = YES`.

## EFEITO COLATERAL ACEITO — Telegram

Com Deployment Protection em "All Deployments", os POSTs para
`/api/telegram/webhook` recebem 401. Aceito explicitamente pelo usuário.
Nenhum `setWebhook`/`deleteWebhook` executado.

**Update 5.5.3**: `getWebhookInfo` (read-only, token do `.env` local — bot
único, `getMe` confirmou token válido/ativo) mostrou que **não há webhook
nenhum configurado** (`WEBHOOK_CONFIGURED=false`, `pending_update_count=0`,
sem `last_error`). Ou seja, o bot já estava sem receber updates por webhook
antes da contenção. Não há webhook legado a preservar ou reverter — no
cutover, `setWebhook` será a configuração inicial.

`TEMPORARY_TELEGRAM_AVAILABILITY_DURING_CONTAINMENT = OFFLINE_BY_CONTAINMENT (aceito; e não havia webhook mesmo)`.

## Update 5.5.3 — provisionamento de secrets de produção

Além da contenção, a Fase 5.5.3 provisionou (via `vercel env add`, todas
`sensitive`, sem efeito no deployment atual):

- `SESSION_SECRET` — `crypto.randomBytes(48)` → 96 hex (segredo técnico,
  sem escolha humana).
- `TELEGRAM_WEBHOOK_SECRET` — `crypto.randomBytes(32)` → 64 hex.
- `DASHBOARD_PASSWORD_HASH` — passphrase forte gerada por CSPRNG (base32
  Crockford, ~93 bits), hasheada com `lib/auth/password.js:hashPassword`
  (scrypt), round-trip verificado localmente. **A passphrase em texto puro
  está SÓ no macOS login keychain** (serviço `norte-dashboard-prod`, conta
  `rcn.dados@gmail.com`) — nunca em repo/doc/log. Recuperar:
  `security find-generic-password -s norte-dashboard-prod -w`.

Nenhum secret aparece neste documento. `SENSITIVE_ENV_AVAILABLE_TO_ENV_RUN
= NO` (provado empiricamente: `vercel env run` responde "Secret values
cannot be pulled").

## Update 5.5.4 — TELEGRAM_ALLOWED_USER_ID capturado

O `from.id` do dono foi obtido **pelo próprio bot**, sem painel/curl/@bots
externos: challenge aleatório `NORTE-VERIFY-…` gerado localmente, o dono
enviou exatamente essa string ao bot, `getUpdates` (read-only, autorizado só
pra esta identificação) achou a update em chat privado, `from.id` extraído,
validado com `lib/auth/telegramSecurity.js:isAuthorizedTelegramSender`
(autoriza o próprio id, nega id diferente, nega null), e provisionado como
`vercel env add TELEGRAM_ALLOWED_USER_ID production --sensitive`. O id nunca
foi impresso em terminal/doc/commit/log. `TELEGRAM_VERIFICATION_UPDATE_HANDLING`:
`offset` avançado só sobre a update do challenge (0 updates posteriores
existiam). Nenhum `sendMessage`/`setWebhook`/lançamento.

## PERMANENT_FIX

Cutover da Fase 5.6: deploy do código V2/auth (os 61 commits) + as 7
migrations pendentes. Depois disso, a proteção de aplicação é a própria
camada de auth do app (`middleware.js` deny-by-default), e a Deployment
Protection da Vercel pode ser reavaliada — provavelmente mantida em
"Standard" (protege previews) com um **Protection Bypass** dedicado só para
o path `/api/telegram/webhook` (que tem o seu próprio segredo de transporte,
`TELEGRAM_WEBHOOK_SECRET`).

## NÃO FAZER até a 5.6

- Não remover a Deployment Protection para "testar" a API antiga.
- Não criar bypass de proteção nesta fase.
- Não deployar o código novo (isso é o cutover).
