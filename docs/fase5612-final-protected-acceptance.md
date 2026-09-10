# Fase 5.6.1.2 — Final Protected Acceptance

**Status: FECHADA. PARADO CONTIDO.** Deployment Protection = `all`. Esta
closure foi **read-only em produção**: zero write financeiro, zero
reconciliation, zero migration, zero deploy, zero `setWebhook`.

Nenhum valor pessoal, nome de credor, secret, token ou connection string
neste documento.

---

## 1. BASE

| | |
|---|---|
| local HEAD | `5cdc0ba` |
| origin/main | `c5d2a91` |
| runtime production commit | `c5d2a91` (deploy `dpl_DqqnGtUgzJAgJ5nmRbfeLLB2UzQE`) |
| working tree | limpa (antes desta closure) |
| branch | `main` |

Docs/tooling desta fase **não** foram pushados.

## 2. PRODUCTION CONTAINMENT

Deployment Protection = **`all`**. `GET /api/dashboard` anônimo → **302**
(redirect do Deployment Protection, antes de qualquer código do app). Não
removido, não reaberto.

## 3. FINANCIAL TRUTH — PRESERVADA

Nenhuma reconciliação reaplicada. Só read/smoke. Engine de produção
(via `GET /api/dashboard` autenticado, deploy `c5d2a91`): **8/8 baseline**
(ver §11). Nenhum dado novo criado em produção.

## 4. FULL TEST INVENTORY

`PHYSICAL_TEST_FILE_COUNT = 43` (contagem física de `scripts/test-*.mjs` —
não presumida).

## 5. FULL REGRESSION

Todos os 43 arquivos `test-*.mjs` executados, **sem exclusão** por
"tooling-only" / "não toca runtime" / "já passou".

| | |
|---|---|
| TOTAL | 43 |
| PASS | **43** |
| FAIL | 0 |

41 rodaram direto; 2 (`test-security-integration.mjs`,
`test-security-ratelimit.mjs`) exigem o dev server em `http://localhost:3001`
— subido o `next dev`, rodaram: **18/18** e **37/37**. Todos verdes.

## 6. BOOTSTRAP GUARD TEST (dentro da suíte)

`scripts/test-bootstrap-guard.mjs` — **19/19**. Prova:

| Requisito do item 6 | Check |
|---|---|
| first use succeeds | [11], [11b] 1ª |
| second use fails | [11b] 2ª (arquivo single-use consumido) → ABORT |
| wrong phase fails | [11c] |
| nonce mismatch fails | [11d] |
| expired fails | [9] (> 60 s) |
| missing fails | [7] |
| allGatesGreen false fails | [10] |
| direct script accident aborts | [12] (`node scripts/apply-*.mjs` sem loader + `DATABASE_ENV=production` → guard ORIGINAL) |

## 7. BUILD / PRISMA

| | |
|---|---|
| `npm run build` | **green** (`✓ Compiled successfully`, todas as rotas, middleware 35 kB) |
| `npx prisma validate` | **valid** |
| `npx prisma migrate status` (DEV, `ep-polished-queen-ac6q7dnc`) | 12 migrations, **"Database schema is up to date!"** |

## 8–11. COOKIE CONTRACT + AUTH REGRESSION (produção, protegida)

Login real no Norte de produção, **atrás do Deployment Protection = all**
(Chrome com sessão Vercel). Passphrase do Keychain
(`security -s norte-dashboard-prod`) só no clipboard do SO, colada com clique
real + `⌘V`; nunca em argumento/log/arquivo/commit. Clipboard higienizado ao
fim, aba fechada.

### Auth chain

| Passo | Resultado |
|---|---|
| `POST /api/auth/login` (senha correta) | **200** |
| redirect | `/` |
| `GET /api/dashboard` autenticado | **200** |
| `POST /api/auth/logout` | **200** |
| `GET /api/dashboard` pós-logout | **401** |

### Cookie metadata (SÓ metadata — nenhum value/token/assinatura impresso)

Runtime observável em produção: `document.cookie` **vazio** e
`cookieStore.getAll()` **`[]`** para `norte_session`, com a sessão
funcionando (dashboard 200) → **HttpOnly confirmado em runtime**. Os demais
atributos vêm do handler deployado (`app/api/auth/login/route.js:94`) e são
verificados em runtime pelo `test-security-integration.mjs` [F], que lê o
`Set-Cookie` cru do MESMO handler (43/43 acima).

| Campo | Valor | Evidência |
|---|---|---|
| `SESSION_COOKIE_NAME` | `norte_session` | código (`lib/auth/session.js:15`) + Set-Cookie DEV |
| `SESSION_COOKIE_HTTP_ONLY` | **true** | prod runtime (JS + cookieStore cegos) + Set-Cookie DEV (`/HttpOnly/i`) |
| `SESSION_COOKIE_SECURE` | **true em produção** (`secure: shouldUseSecureCookie()` = `isProductionRuntime()` = `NODE_ENV==="production"`); false em dev (http local, correto) | código (`app/api/auth/login/route.js:96`, `lib/auth/envConfig.js:48`) |
| `SESSION_COOKIE_SAME_SITE` | **Lax** | código (`:97`) + Set-Cookie DEV (`/SameSite=Lax/i`) |
| `SESSION_COOKIE_PATH` | **`/`** | código (`:98`) |
| `SESSION_COOKIE_EXPIRY_MODE` | **Max-Age (persistente)**, `SESSION_TTL_SECONDS` = 30 dias (`exp − now` no set) | código (`:99`, `lib/auth/session.js:16`, `session.js:105`) |

Logout: `res.cookies.delete("norte_session")` (`app/api/auth/logout/route.js`)
→ Set-Cookie de expiração; runtime: `/api/dashboard` passa a 401.

`SESSION_COOKIE_RUNTIME_CONTRACT_MATCH = YES` — todo atributo observável em
runtime bate com o contrato do código; os não-observáveis por JS (Secure,
Path, Max-Age) são governados pelo mesmo handler que a suíte exercita
diretamente contra o `Set-Cookie` cru.

### DEPLOYED_AUTHENTICATED_API_FINGERPRINT — 8/8 (ver §11)

## 11. AUTH REGRESSION — FINGERPRINT

`GET /api/dashboard` → 200, deploy `c5d2a91`, sessão real, DB de produção:

| # | Campo | Live autenticado | Baseline | |
|---|---|---|---|---|
| 1 | `unrestrictedCash` | 2879.17 | 2879.17 | ✅ |
| 2 | `freeMoney` | -302.80 | -302.80 | ✅ |
| 3 | `safeToSpend` | 0 | 0 | ✅ |
| 4 | `status` | APERTADO | APERTADO | ✅ |
| 5 | `nextIncome.baseAmount` | 4937.18 | 4937.18 | ✅ |
| 6 | `nextIncomeCommitment.committedAmount` | 2189.06 (44.34 %) | 2189.06 | ✅ |
| 7 | `restricted.vaBalance` | 587.23 | 587.23 | ✅ |
| 8 | `currentObligations.incurredLiabilities` | 716.97 | 716.97 | ✅ |

`nextIncomeCommitment` breakdown: card 716.97 + external 1472.09 + other 0 =
2189.06 — coerente com a reconciliação.

## 12–17. MOBILE 390 — EMULAÇÃO REAL

O smoke da 5.6.1.1 chegou só a ~500 px (piso físico da janela do Chrome).
Agora: **viewport 390 real** via emulação CDP do browser in-app, contra
`http://localhost:3001` (dev server, branch DEV — que está reconciliado
**idêntico** à produção, é a origem do baseline). Login: fixture de dev
`norte-dev-only-password` (não-segredo, declarado em
`test-security-integration.mjs:26`).

### MOBILE WIDTH PROOF (item 13)

| | |
|---|---|
| `window.innerWidth` | **390** |
| `document.documentElement.clientWidth` | **390** |
| `devicePixelRatio` | 2 |

Não é ~500. Emulação de viewport, não resize de janela do SO.

### Protected smoke @ 390 (navegação real da UI)

| Página | Rota | `overflowX` | Render / dados |
|---|---|---|---|
| Hoje / Home | `/` | **false** | Apertado · -R$ 302,80 · Seguro R$ 0,00 · Tattoo R$ 2.465,00 · Próxima renda R$ 4.937,18 |
| Cartão | `/cartoes` | **false** | Fatura R$ 716,97 · 34 % · R$ 1.378,15/4.027,00 · disp. R$ 2.648,85 · próximas 479,38 / 60,60 |
| A pagar | `/compromissos` | **false** | Horizonte R$ 3.181,97 · Sai da próxima renda R$ 2.189,06 · Parcelas externas R$ 1.472,09 (9 planos) |
| Simular | `/simulador` | **false** | form + 4 modos, renderiza (sem nova simulação — zero-persistence já provado) |
| Fluxo | `/fluxo` (via Mais) | **false** | trajetória de caixa, seletor 7/30/60/90/180d |
| Histórico | `/historico` (via Mais) | **false** | ciclo 24/08–23/09, breakdown por categoria |
| Metas | `/metas` (via Mais) | **false** | "Nenhuma meta ainda" + Nova meta |

### MOBILE CHECKS (item 15)

- **zero horizontal overflow** em todas as 7 rotas (`scrollWidth == innerWidth == 390`)
- **bottom navigation**: `Hoje · Cartão · A pagar · Simular · Mais` (5 itens, ícones SVG, ativo em âmbar)
- **"Mais"**: abre e expõe `Fluxo`, `Histórico`, `Metas` (+ nav completa)
- nenhum conteúdo cortado (labels longos truncam com reticências — "Beatriz / Tiger regularization (par…" — graceful, não clipping)
- nenhum modal/dialog inutilizável; controles principais acessíveis
- dados canônicos renderizados

### MOBILE FINANCIAL TRUTH (item 16)

`GET /api/dashboard` na sessão mobile 390: `unrestrictedCash 2879.17 ·
freeMoney -302.80 · safeToSpend 0 · APERTADO · vaBalance 587.23 ·
incurred 716.97` — **mesma truth**, sem divergência. Home/mobile consome o
mesmo `financial` read-model.

### Simulador mobile (item 17)

`/simulador` renderiza em 390 (form + resultado). Nenhuma write nova.

## 18. LOGOUT / CLEANUP

Logout em produção (`/api/dashboard` → 401) e no dev (`→ 401`). Clipboard
higienizado. Abas fechadas. Dev server parado. Viewport resetado pra desktop.
Nenhuma sessão aberta.

## 19. PRODUCTION WRITE ACCOUNTING — esta closure

| | |
|---|---|
| `PRODUCTION_FINANCIAL_BUSINESS_WRITES` | **0** |
| `PRODUCTION_RECONCILIATION_WRITES` | **0** |
| `PRODUCTION_SCHEMA_WRITES` | **0** |
| `PRODUCTION_CONFIG_WRITES` | **0** |
| `PRODUCTION_DEPLOY_WRITES` | **0** |
| `TELEGRAM_MUTATING_API_CALLS` | **0** |

Metadata normal de login/sessão/rate-limit (classificada à parte): 2 logins
de produção + 2 logouts nesta closure (`POST /api/auth/login` ×2 → 200,
`POST /api/auth/logout` ×2 → 200), mais o `clearAttempts` do rate limiter
que roda após login bem-sucedido. Nenhuma escrita de negócio/financeira.

## 20. FINAL WRITE ACCOUNTING — bootstrap histórico (preservado, do doc reconciliado)

Confirmado em `docs/fase5611-protected-runtime-acceptance.md` §2 (não
recalculado por memória):

| | |
|---|---|
| `PRODUCTION_CONFIG_BOOTSTRAP_WRITES` | 1 |
| `PRODUCTION_RECONCILIATION_CREATES` | **60** |
| `PRODUCTION_RECONCILIATION_UPDATES` | **24** |
| `EXPECTED_RECONCILIATION_DELETES` | 1 |
| `UNEXPECTED_RECONCILIATION_DELETES` | 0 |
| `EXPECTED_CANONICAL_VALUE_CORRECTIONS` | 1 |
| `NET_CANONICAL_CORRECTION` | +0.05 |
| `UNEXPECTED_FINANCIAL_WRITES` | 0 |

## 21. CARD DUE-DATE OBSERVATION — classificada

`/cartoes` mostra "vence 11/10/2026 · ciclo 2026-10" para a fatura atual.

**Não é bug — é comportamento correto.** O `computeDueAt` "sempre soma um
mês" que a auditoria original achou (P1-3) **já foi corrigido na Fase 4.0**:
a lógica foi extraída pra `lib/cardCycle.js:getCardBillDueDate`, que agora
compara `dueDay` com `closingDay`:

```
dueDay (11) >= closingDay (4)  ->  monthOffset = 0
dueAt = dia 11 do MESMO mês de referência do ciclo
```

O ciclo `2026-10` (com `closingDay=4`) cobre 05/09 → 04/10, **fecha** em
04/10 e **vence** em 11/10 — exatamente a regra do Itaú real (fecha 4, vence
11). A liability de outubro (716.97) e a data (11/10) são coerentes com o
fingerprint.

| | |
|---|---|
| `BLOCKS_FINANCIAL_TRUTH` | **NO** (fingerprint usa `cycleMonth`; os 8 valores batem; `dueAt` correto) |
| `BLOCKS_PUBLIC_CUTOVER` | **NO** |
| Label problem | **NO** — "ciclo 2026-10 · vence 11/10" é a convenção `cycleReference` (mês em que fecha) e está semanticamente certo |

Nenhuma alteração de runtime. Nenhum follow-up P1 necessário.

## 22–24. FINAL PROTECTED GATES

| Gate | |
|---|---|
| `FULL_REGRESSION_POST_TOOLING` | **YES** (43/43) |
| `BUILD_READY` | **YES** |
| `PRISMA_READY` | **YES** (schema valid, DEV up to date) |
| `SESSION_COOKIE_RUNTIME_CONTRACT_MATCH` | **YES** |
| `DEPLOYED_AUTHENTICATED_API_TRUTH_READY` | **YES** (8/8) |
| `PRODUCTION_FINANCIAL_TRUTH_READY` | **YES** |
| `PRODUCTION_APP_PROTECTED_SMOKE_READY` | **YES** (7 rotas, desktop + 390) |
| `PRODUCTION_MOBILE_390_SMOKE_READY` | **YES** (`innerWidth = 390`, zero overflow, nav ok, truth ok) |
| `BOOTSTRAP_AUTH_ARTIFACT_SAFE` | **YES** (single-use, `PERSISTED_AFTER_RUN = NO`) |
| `WRITE_ACCOUNTING_RECONCILED` | **YES** (60 / 24 / 1) |
| `PRODUCTION_PRIVACY_CONTAINED` | **YES** (Deployment Protection = `all`, anon → 302, zero write) |

### FASE 5.6.1 FINAL

| | |
|---|---|
| **`FASE_5_6_1_PRODUCTION_RECONCILIATION_READY`** | **YES** |
| **`FASE_5_6_1_FORMALLY_CLOSED`** | **YES** |

## 25. STOP

PARADO CONTIDO. Deployment Protection continua `all`. **Não** foi feito:
`All → Standard`, `setWebhook`, Telegram production, continuação do cutover
público, deploy novo, bootstrap financeiro adicional. Aguardando sua revisão
antes de remover a camada externa de proteção.
