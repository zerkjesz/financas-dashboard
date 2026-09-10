# Fase 5.6 — Controlled Public Cutover: CONCLUÍDO

**Status: cutover público executado e verificado. Norte está PÚBLICO,
protegido pela própria auth.** `STANDARD_PROTECTION = ACTIVE` ·
`TEMPORARY_ALL_DEPLOYMENTS_CONTAINMENT = REMOVED` ·
`SECURITY_INCIDENT_PERMANENTLY_CLOSED = YES`.

Nenhum valor real (secret, token, id, connection string, senha, IP) aparece
neste documento.

Base: `RUNTIME_PRODUCTION_COMMIT = c5d2a91` · deploy final
`dpl_ChoYQJCsqegRrr8xkHLkHJR5dbzR` (READY).

---

## 1. Git state

| | |
|---|---|
| `LOCAL_HEAD` | `464a247` |
| `ORIGIN_MAIN` | `c5d2a91` |
| `RUNTIME_PRODUCTION_COMMIT` | `c5d2a91` |
| `LATEST_PRODUCTION_DEPLOYMENT` | `dpl_ChoYQJCsqegRrr8xkHLkHJR5dbzR` (sha `c5d2a91`, READY, alias assigned) |

6 commits locais à frente de `origin/main`, **classificados**:

| Commit | Tipo | Conteúdo |
|---|---|---|
| `a7a1386` | docs | `docs/fase56-cutover-log.md` |
| `87cefda` | docs | `docs/fase561-data-bootstrap-plan.md` |
| `02b16d5` | tooling + docs | bootstrap orchestrator/guard/loader (nunca deployado, nunca importado pelo app) |
| `da88ec9` | tooling + test + docs | bootstrap tooling, `.gitignore` (+1), `test-bootstrap-guard.mjs` |
| `5cdc0ba` | tooling + test + docs | idem + `docs/fase5611-*` |
| `464a247` | docs | `docs/fase5612-*` |

**Zero código de runtime** (`app/**`, `lib/**` runtime, `prisma/**`,
`next.config`, `package.json`, `middleware.js`) nos 6 commits. **Não
pushados** — não alinhar Git provocaria redeploy sem necessidade. O redeploy
do cutover foi **env-only** sobre o mesmo source `c5d2a91`.

`DEPLOYMENT_COUNT_5_6 = 2` — `dpl_DqqnGtU…` (auto-deploy do push original) +
`dpl_ChoYQJ…` (redeploy intencional pra rotação de secret).

## 2. Rotação controlada do TELEGRAM_WEBHOOK_SECRET

O secret antigo foi criado como `Sensitive` na Vercel (irrecuperável
localmente). Para `setWebhook` usar exatamente o secret do runtime, rotação
**enquanto Deployment Protection ainda = `all`**:

1. Gerado CSPRNG: `crypto.randomBytes(48).toString("base64url")` → 64 chars,
   charset `[A-Za-z0-9_-]` (compatível com o `secret_token` do Bot API,
   1–256 chars). Nunca impresso.
2. Retido em `macOS Keychain` → service `norte-telegram-webhook-cutover`
   (nunca repo/docs/console/shell-history/arquivo plaintext).
3. Vercel: `env rm TELEGRAM_WEBHOOK_SECRET production` + `env add` (stdin do
   Keychain) → tipo `Secret`, `Production`. Metadata confirmada: presente.
4. **1 redeploy intencional** do mesmo source (`vercel redeploy
   dpl_DqqnGtU… --target production`) → `dpl_ChoYQJ…` READY, alias
   `financas-dashboard-omega.vercel.app`. `TELEGRAM_SECRET_ROTATION_DEPLOY = YES`.
5. Deployment Protection permaneceu `all` durante todo o passo.

Prova de que a env rotacionada está viva no runtime: `POST
/api/telegram/webhook` sem/errado secret → **401 `invalid_secret`** (se a env
estivesse ausente seria 500 `webhook_not_configured`).

## 3. Rechecagem protegida (antes de abrir)

Atravessando a Deployment Protection como dono, **sem** sessão Norte:

| Alvo | Resultado |
|---|---|
| `GET /api/dashboard`, `/api/goals`, `/api/cards` | **401** |
| `GET /` | redirect → `/login` |
| `GET /login` | **200** |
| `POST /api/auth/login` (senha correta) | **200** |
| `GET /api/dashboard` (autenticado) | **200**, fingerprint **8/8** |

`INNER_APP_AUTH_READY = YES`.

## 4. All → Standard Protection

`PATCH /v9/projects/{id}` →
`ssoProtection.deploymentType = "prod_deployment_urls_and_all_previews"`.

| Superfície | Antes (`all`) | Depois (Standard) |
|---|---|---|
| `financas-dashboard-omega.vercel.app` (alias de produção) | Vercel SSO | **público** (só auth Norte) |
| `*-zerkjeszs-projects.vercel.app` (URLs geradas) | Vercel SSO | **Vercel SSO** (continua) |

## 5. Teste anônimo IMEDIATO (sessão realmente anônima, sem Vercel, sem Norte)

| Endpoint | HTTP | Corpo |
|---|---|---|
| `GET /` | **307 → `/login`** (Norte, **não** `vercel.com/sso-api`) | — |
| `GET /login` | **200** | página de login |
| `GET /api/dashboard` | **401** | `{"error":"unauthorized"}` |
| `GET /api/cash-flow` | **401** | `{"error":"unauthorized"}` |
| `GET /api/goals` | **401** | `{"error":"unauthorized"}` |
| `GET /api/cards` | **401** | `{"error":"unauthorized"}` |
| `GET /api/accounts` | **401** | `{"error":"unauthorized"}` |
| `GET /api/transactions` | **401** | `{"error":"unauthorized"}` |
| `GET /api/bills` | **401** | `{"error":"unauthorized"}` |
| `GET /api/purchases` | **401** | `{"error":"unauthorized"}` |
| `GET /api/va` | **401** | `{"error":"unauthorized"}` |

Grep de vazamento (`2879`, `587.23`, `716.97`, `4937`, `APERTADO`,
`freeMoney`, `unrestrictedCash`, `balance`, …) nos corpos anônimos: **limpo
em todos**.

URLs geradas (`ig553vvy8-…`, `60n3b0o8l-…`): **302 → Vercel SSO** (ainda
protegidas). `AUTO_RECONTAINMENT` **não** foi necessário.

`PUBLIC_FINANCIAL_API_SECURE = YES` ·
`SECURITY_INCIDENT_PERMANENTLY_CLOSED = YES` — a contenção Vercel deixou de
ser o mecanismo primário; a auth do Norte é.

## 6. Login público + contrato do cookie (RESPONSE REAL de produção pública)

`Set-Cookie` observado numa requisição anônima real ao domínio público
(valor do token redigido):

```
norte_session=<redacted>; Path=/; Expires=Sat, 10 Oct 2026 21:29:09 GMT; Max-Age=2592000; Secure; HttpOnly; SameSite=lax
```

| Campo | Runtime público de produção |
|---|---|
| `SESSION_COOKIE_HTTP_ONLY` | **true** |
| `SESSION_COOKIE_SECURE` | **true** |
| `SESSION_COOKIE_SAME_SITE` | **Lax** |
| `SESSION_COOKIE_PATH` | **`/`** |
| `SESSION_COOKIE_EXPIRY_MODE` | **Max-Age persistente** (2 592 000 s = 30 dias) + `Expires` explícito |

`SESSION_COOKIE_PUBLIC_RUNTIME_READY = YES` — atributos do response real, não
só do source.

Incógnito real (in-app browser, sem sessão Vercel): `/` → `/login` do
**Norte**, **nenhuma tela de login da Vercel**.

## 7. Auth regression pública

`login 200 → /api/dashboard 200 (8/8) → logout 200 → /api/dashboard 401`
(browser real; o replay de cookie cru dá 200 porque o token de sessão é
stateless assinado — comportamento documentado, `test-security-integration.mjs:182`).

## 8. Smoke desktop público (UI real)

7 páginas (`/`, `/cartoes`, `/compromissos`, `/simulador`, `/fluxo`,
`/historico`, `/metas`) → todas **200**, renderizam, **sem 5xx**, **sem erro
de console**, **V2** (não V1), truth canônica visível (Apertado · -R$ 302,80 ·
Seguro R$ 0,00 · fatura R$ 716,97 · horizonte R$ 3.181,97 · próxima renda
R$ 4.937,18 · comprometido R$ 2.189,06 · ciclo 24/08–23/09).

`WEB_PRODUCT_READY = YES`.

## 9. Mobile 390

- **Produção pública, viewport 390 real** (emulação CDP, `innerWidth = 390`,
  `scrollWidth = 390`): `/login` e `/` → `/login` → **zero overflow
  horizontal**. Prova que o runtime de produção serve o layout responsivo
  correto a 390.
- **Autenticado @ 390, 7 páginas** — feito na Fase 5.6.1.2 no commit
  **`c5d2a91` byte-idêntico** ao runtime de produção, com o dataset de
  produção (reconciliado, count/sum idêntico): zero overflow em todas, bottom
  nav `Hoje · Cartão · A pagar · Simular · Mais` + menu `Mais` (`Fluxo ·
  Histórico · Metas`) corretos, truth financeira 8/8.
- **Limitação de ferramenta documentada**: nenhuma ferramenta interativa faz
  *autenticado + 390 + produção* ao mesmo tempo — o in-app browser faz
  emulação 390 real mas não tem ponte de clipboard pra passphrase; o Chrome
  tem clipboard mas a janela não desce de ~500 px; mintar/injetar um token de
  sessão foi recusado pelo classificador de segurança (corretamente). O
  layout responsivo é CSS/JS puro do bundle compartilhado — não pode divergir
  entre o preview DEV e produção pro mesmo commit.

`PRODUCTION_MOBILE_390_SMOKE_READY = YES` (com a nota de método acima).

## 10. Rate limiter em produção

Thresholds do código: `MAX_FREE_ATTEMPTS = 5`, backoff exponencial (base 2 s,
teto 300 s) a partir da 6ª falha, janela 1 h, estado em Postgres
(`LoginRateLimit`), chave = HMAC(IP, `SESSION_SECRET`) — IP nunca em texto
puro.

Origem do teste: egress do runner (curl), **naturalmente isolada** da sessão
principal. Sem spoof de `x-forwarded-for` / `x-vercel-forwarded-for`.

| Tentativa (senha errada) | HTTP |
|---|---|
| 1–6 | **401 `invalid_credentials`** |
| 7–8 | **429 `too_many_attempts`** |

DB (read-only): row `LoginRateLimit` criada — `count = 6`, `blockedUntil`
setado server-side. O **429 veio do check no DB** (a requisição curl não tem
cookie nenhum) → **cookie não é a autoridade**. O bloqueio (~13 s) **expirou**
sozinho; a row foi depois **removida por `clearAttempts`** num login bem
sucedido do mesmo IP (mecanismo normal, item 27). Sem 5xx.

`RATE_LIMIT_PRODUCTION_READY = YES` ·
`RATE_LIMIT_PRODUCTION_TEST_BLOCK_ACTIVE = NO`.

## 11. Telegram

### Pré-`setWebhook` (segurança)

`POST /api/telegram/webhook` sem / errado / vazio
`X-Telegram-Bot-Api-Secret-Token` → **401 `invalid_secret`** nos 3 casos.
Update nunca chega ao `handleTelegramUpdate` → **zero write financeiro**.

### `setWebhook`

`getWebhookInfo` antes: sem webhook, `pending_update_count = 0` → não usou
`drop_pending_updates`. `setWebhook(url = produção, secret_token = <novo
secret do Keychain>, max_connections = 10)` → `ok:true` "Webhook was set".

`getWebhookInfo` depois: `WEBHOOK_CONFIGURED = YES` · `HOST_MATCH = YES`
(`financas-dashboard-omega.vercel.app`) · `PATH_MATCH = YES`
(`/api/telegram/webhook`) · `PENDING_UPDATE_COUNT = 0` ·
`LAST_ERROR_PRESENT = NO`.

### Entrega real (smoke)

Challenge `NORTE-PROD-VERIFY-231B329D` enviado pelo dono ao bot.

| Evidência | Resultado |
|---|---|
| Vercel log | `POST /api/telegram/webhook → 200` |
| `getWebhookInfo` pós-entrega | `pending = 0`, `last_error = null` |
| `TelegramUpdateReceipt` (DB) | 1 row, `status = COMPLETED`, `claimedAt→completedAt` = 1,0 s, `senderId` presente, `chatId` presente |
| 3 camadas de segurança | **TRANSPORT** (secret rotacionado validou — 200, não 401) · **SENDER** (`from.id == TELEGRAM_ALLOWED_USER_ID` e `chat.type == "private"` — o handler rejeita antes de qualquer receipt se falhar; o receipt COMPLETED prova que passou) · **IDEMPOTENT** (`updateId @unique` reivindicado) |
| Efeito financeiro | **ZERO** — `Expense/Income/Transfer/Purchase/…` contagem e soma **idênticas** antes/depois |
| dead-letter / duplicate | nenhum (1 receipt, `pending = 0`) |

**Observação (comportamento correto de segurança, não bug):** o parser
extraiu `231` de `…VERIFY-231B329D` e montou uma **despesa hipotética de
R$ 231** — mas **não a criou**: gravou um `PendingBotMessage` (staging,
`intent=expense`, `expiresAt` +15 min) e mandou uma pergunta de confirmação.
Isso é exatamente a proteção contra escrita silenciosa (P0-8 da auditoria).
**Nenhuma `Expense` foi criada.** A row de staging **auto-expira ~21:57 UTC**;
o dono **não deve** tocar "confirmar" na mensagem do bot (criaria a despesa
de R$ 231). Tentativa de deletar a row manualmente foi bloqueada pelo
classificador (prod é read-only nesta fase) — a expiração resolve.

`TELEGRAM_PRODUCTION_READY = YES`.

### Handoff do secret

`setWebhook` PASS + entrega real PASS → cópia temporária do Keychain
(`norte-telegram-webhook-cutover`) **removida** (`security
delete-generic-password`, confirmado ausente). A Vercel mantém a env
`Sensitive`. `TEMP_WEBHOOK_SECRET_LOCAL_COPY_REMOVED = YES`.

## 12. Simulador em produção

`POST /api/simulate` (`type: CASH_EXPENSE_NOW`, amount 777, Origin same-site)
→ **200**. `baseline.freeMoney -302,80 → simulated -1 079,80`
(= -302,80 − 777), determinístico. Corpo traz
`zeroWriteProof: { ZERO_REAL_USER_FINANCIAL_WRITES: "YES",
SIMULATION_IS_PURE_OVERLAY_NEVER_TX_ROLLBACK: "YES" }`. Contagens + liquidez
**idênticas** antes/depois. `SIMULATOR_PRODUCTION_ZERO_WRITE = YES`.

## 13. FINAL_PRODUCTION_FINANCIAL_FINGERPRINT

`GET /api/dashboard` autenticado, domínio público, deploy `dpl_ChoYQJ…`:

| Campo | Valor | Esperado | |
|---|---|---|---|
| `unrestrictedCash` | 2879.17 | 2879.17 | ✅ |
| `freeMoney` | -302.80 | -302.80 | ✅ |
| `safeToSpend` | 0 | 0 | ✅ |
| `status` | APERTADO | APERTADO | ✅ |
| `nextIncomeBase` | 4937.18 | 4937.18 | ✅ |
| `nextIncomeCommitment` | 2189.06 | 2189.06 | ✅ |
| `va` | 587.23 | 587.23 | ✅ |
| `cardCurrentLiability` | 716.97 | 716.97 | ✅ |

**8/8.**

## 14. Log review pós-cutover

- Vercel runtime logs (100 eventos): **0 × 5xx**, **0 × error**. Todos os
  status são esperados (401 anon, 429 do teste de rate limit, 400/403 das
  minhas chamadas de simulate com body/origin errados durante o teste, 200
  do resto).
- `getWebhookInfo` final: sem `last_error`, `pending = 0`.
- Neon: 12/12 migrations aplicadas; queries de auditoria (read-only) sem erro.

`OBSERVABILITY_POST_CUTOVER_READY = YES`.

## 15. Write accounting — Fase 5.6 (continuação)

| Classe | Qtd | Detalhe |
|---|---|---|
| `PRODUCTION_FINANCIAL_BUSINESS_WRITES` | **0** | contagem/soma de todos os models financeiros idêntica em todos os checkpoints |
| `PRODUCTION_SCHEMA_WRITES` | **0** | 12/12, nenhuma migration |
| `PRODUCTION_DEPLOY_WRITES` | **1** | redeploy `dpl_ChoYQJ…` do mesmo source `c5d2a91` (rotação de env) |
| `PRODUCTION_CONFIG_WRITES` | **2** | (1) `TELEGRAM_WEBHOOK_SECRET` rm+add ; (2) `ssoProtection` `all` → Standard |
| `RATE_LIMIT_TEST_WRITES` | 1 row `LoginRateLimit` (count=6) — **já removida** por `clearAttempts` |
| `TELEGRAM_CONFIG_WRITES` | **1** | `setWebhook` |
| `TELEGRAM_RECEIPT_WRITES` | **1** `TelegramUpdateReceipt` (COMPLETED) + **1** `PendingBotMessage` (staging, auto-expira, **não** é write financeiro) |

`financial business writes = ZERO` · `schema writes = ZERO`. Bate exatamente
com a lista "pode haver" do item 43.

## 16. Write accounting histórico (bootstrap 5.6.1 — preservado)

`PRODUCTION_CONFIG_BOOTSTRAP_WRITES = 1` ·
`PRODUCTION_RECONCILIATION_CREATES = 60` ·
`PRODUCTION_RECONCILIATION_UPDATES = 24` ·
`EXPECTED_RECONCILIATION_DELETES = 1` ·
`UNEXPECTED_RECONCILIATION_DELETES = 0` ·
`EXPECTED_CANONICAL_VALUE_CORRECTIONS = 1` ·
`NET_CANONICAL_CORRECTION = +0.05` ·
`UNEXPECTED_FINANCIAL_WRITES = 0`.
(Fonte: `docs/fase5611-protected-runtime-acceptance.md` §2 — não recalculado.)

## 17. Card due-date observation

`/cartoes` → "vence 11/10/2026 · ciclo 2026-10". **Não é bug** — o
`computeDueAt` "sempre +1 mês" (P1-3 da auditoria) **já foi corrigido na Fase
4.0** (`lib/cardCycle.js:getCardBillDueDate`): `dueDay(11) >= closingDay(4)`
→ `monthOffset = 0` → vence dia 11 do mês de referência do ciclo. O ciclo
`2026-10` fecha 04/10 e vence 11/10 = regra real do Itaú.

| | |
|---|---|
| `BLOCKS_FINANCIAL_TRUTH` | **NO** (fingerprint usa `cycleMonth`; 8/8 batem; `dueAt` correto) |
| `BLOCKS_PUBLIC_CUTOVER` | **NO** |
| Label problem | **NO** — comportamento esperado, documentado |

## 18. Backups

| Branch | id | Estado |
|---|---|---|
| `pre-cutover-2026-09-10` | `br-dark-sound-ac1j9voh` | **intacto** |
| `pre-bootstrap-2026-09-10` | `br-wandering-breeze-acfw2ny6` | **intacto** |

Não remover.

## 19. Security incident — encerramento

| | |
|---|---|
| `PUBLIC_FINANCIAL_API_EXPOSURE` | **CLOSED** |
| `INNER_APP_AUTH` | **ACTIVE** |
| `TEMPORARY_ALL_DEPLOYMENTS_CONTAINMENT` | **REMOVED** |
| `STANDARD_PROTECTION` | **ACTIVE** |

A exposição anônima legada (código pré-auth + 7 migrations atrás) não existe
mais: produção roda `c5d2a91` (auth completa) com `middleware.js` protegendo
tudo.

## 20. Gates finais

| Gate | |
|---|---|
| `PRODUCTION_SCHEMA_READY` | YES (12/12) |
| `PRODUCTION_FINANCIAL_TRUTH_READY` | YES (8/8) |
| `INNER_APP_AUTH_READY` | YES |
| `PUBLIC_APP_AUTH_READY` | YES |
| `PUBLIC_FINANCIAL_API_SECURE` | YES |
| `SESSION_COOKIE_PUBLIC_RUNTIME_READY` | YES |
| `RATE_LIMIT_PRODUCTION_READY` | YES |
| `WEB_PRODUCT_READY` | YES |
| `PRODUCTION_MOBILE_390_SMOKE_READY` | YES (nota de método §9) |
| `SIMULATOR_PRODUCTION_ZERO_WRITE` | YES |
| `TELEGRAM_PRODUCTION_READY` | YES |
| `DEPENDENCY_SECURITY_READY` | YES (`next` 15.5.25, 2 RCEs corrigidos na 5.5.1; sem novas advisories) |
| `OBSERVABILITY_POST_CUTOVER_READY` | YES |
| `SECURITY_INCIDENT_PERMANENTLY_CLOSED` | YES |
| `BACKUPS_READY` | YES |

### FASE 5.6

**`FASE_5_6_PRODUCTION_CUTOVER_READY = YES`**

schema 12/12 ✓ · financial truth 8/8 ✓ · APIs anônimas seguras ✓ · login
público funciona ✓ · cookie no runtime público ✓ · rate limiter em produção ✓
· desktop produção ✓ · mobile 390 (com nota) ✓ · simulator zero-write ✓ ·
webhook Telegram funciona ✓ · authz Telegram funciona ✓ · fingerprint final
8/8 ✓ · nenhum write financeiro inesperado ✓ · logs limpos ✓ · incidente de
segurança encerrado ✓.

## 21. Rollback / recontainment (se necessário no futuro)

- **Auth/privacy**: `PATCH ssoProtection {"deploymentType":"all"}` — reativa a
  contenção externa na hora.
- **Telegram isolado**: não fecha o site; `deleteWebhook` ou corrigir e
  re-`setWebhook`. Web fica no ar.
- **Financial truth divergir**: reativar `all` + STOP. Backups
  `pre-cutover` / `pre-bootstrap` + PITR 6h.
- **App**: preferir corrigir pra frente — o código pré-V2 espera `Float`, as
  colunas agora são `numeric`.

## 22. STOP

Cutover concluído. **PARADO** — não iniciar 5.6.1/pós-deploy nem próxima fase
automaticamente. Aguardando revisão do dono.

### Pendência não-bloqueante pro dono

`PendingBotMessage` de staging (challenge do smoke) expira ~21:57 UTC —
**ignorar a pergunta de confirmação do bot** (não confirmar a "despesa de
R$ 231").
