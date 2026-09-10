# Fase 5.6.2 — Telegram Intent Safety + True Prod Mobile Closure

**Status: FECHADA.** Os 2 gaps finais da 5.6 resolvidos. Site permanece no
ar, público, protegido pela auth própria. `STANDARD_PROTECTION = ACTIVE` —
**não** reaberto.

Nenhum valor real (secret, token, id, senha, IP) neste documento.

Base: `RUNTIME_PRODUCTION_COMMIT = 750d678` · deploy
`dpl_6V59Cu7RtyhZe477YSVTU3LpGGkf` (READY).

---

## Anchor

`PRE_562_PRODUCTION_FINANCIAL_FINGERPRINT` (engine, read-only, antes do fix):
**8/8** — `2879.17 / -302.80 / 0 / APERTADO / 4937.18 / 2189.06 / 587.23 /
716.97`. Expense count 113.

Challenge pendente do smoke da 5.6 (`NORTE-PROD-VERIFY-231B329D`): expirou
`21:57:40Z` sem confirmação → **nenhuma Expense criada**. Depois **auto-
removido** pelo próprio handler (`consumePendingIfPresent` deleta pending
expirado no próximo acesso ao chat).

---

## GAP A — Telegram false-positive intent parsing

### FALSE_POSITIVE_ROOT_CAUSE

`NORTE-PROD-VERIFY-231B329D` → possível Expense de R$231. Duas causas
compostas:

1. **`lib/amountExtractor.js`** — `NUMBER_RE` casa qualquer sequência de
   dígitos, inclusive `231` e `329` dentro do token alfanumérico
   `231B329D`. Os filtros existentes (quantidade "2 caixas", "dia N") não
   cobriam "dígito colado a letra = identificador".
2. **`lib/intentClassifier.js:classifyIntent`** — o fallback final era
   `return { intent: "expense", … }` **incondicional**. Qualquer texto que
   não casasse nenhuma regra específica virava `expense`; combinado com um
   número extraído, `parseTransaction` montava um candidato (ambíguo por ter
   2 números) → `PendingBotMessage`.

`parseTransaction` só abortava quando `amount === null` — a mera presença de
um número era tratada como suficiente. **O bug é conceitual: existência de
número no texto ≠ intenção financeira.**

### Correção — GENÉRICA (sem hardcode do challenge)

| Arquivo | Mudança |
|---|---|
| `lib/amountExtractor.js` | Descarta candidato cujo dígito está colado a uma letra (prev/next char), **salvo** contexto de moeda na vizinhança (`"50reais"`). Identificadores (token, código de pedido, placa, modelo, UUID) deixam de virar valor. |
| `lib/intentClassifier.js` | **INTENT ANTES DE AMOUNT**: novo `hasFinancialIntentEvidence()` — o fallback só vira `expense` com ≥1 sinal positivo (verbo financeiro / substantivo financeiro / marcador de moeda / método de pagamento / número com contexto de moeda). Sem nenhum → **`no_financial_intent`**. |
| `lib/parseTransaction.js` | `no_financial_intent` → `return null` → `processTelegramMessage` responde o help neutro ("Não consegui achar um valor… tenta '50 mercado pix'"). **Zero `PendingBotMessage`.** P0-8 (confirmação antes de escrita) **intacto** — nada nesse caminho mudou. |

### Testes (`scripts/test-telegram-intent-safety.mjs` — novo, 51 checks)

- **FALSE POSITIVE CORPUS** (item 7): challenge/token, código de pedido,
  data, hora, percentual, versão, telefone, placa/modelo, UUID,
  parcelamento-como-pergunta → **todos `parseTransaction() === null`**, zero
  candidato, zero PendingBotMessage.
- **TRUE POSITIVE CORPUS** (item 8): `gastei 35 no almoço`, `paguei 120 de
  gasolina`, `recebi 500`, `comprei por 200 no cartão`, `fatura 900`,
  `R$ 1.200,00 no mercado`, `50 reais de uber`, `torrei 300…`, `custou
  45,90` → **todos preservados** (mesmo intent, mesmo valor).
- **AMBIGUITY SAFETY** (item 6): números sem intenção clara →
  `no_financial_intent`.
- **READ INTENTS** (item 10): "quanto tenho?", "quanto posso gastar?",
  "quanto tenho de vale?", "como eu tô?" → continuam READ, zero
  PendingBotMessage.

### Regressão

`PHYSICAL_TEST_FILE_COUNT = 44` · **44/44 PASS** · `npm run build` green ·
`prisma validate` OK · DEV fingerprint **8/8** (o parser não é importado
pelo financial engine).

Telegram — **NÃO alterado** (item 11): validação do webhook secret,
allowlist `from.id`, exigência de private chat, `TelegramUpdateReceipt`,
idempotência, dead-letter.

### Deploy

`TELEGRAM_INTENT_FIX_COMMIT = 750d678`. `git fetch` → `origin/main` ainda
`c5d2a91` (sem mudança inesperada). Fast-forward push
`c5d2a91..750d678` (8 commits — só `lib/{amountExtractor,intentClassifier,
parseTransaction}.js` afeta runtime; os outros 7 são docs + tooling de
bootstrap + teste, inertes pro build). Vercel auto-deploy
`dpl_6V59Cu7RtyhZe477YSVTU3LpGGkf` sha `750d678` **READY**, sem erro de
build. Schema **12/12 inalterado**.

### Recheck pós-deploy

| | |
|---|---|
| anon `/` | 307 → `/login` |
| anon `/login` | 200 |
| anon `/api/dashboard /cards /accounts /cash-flow /goals` | **401**, `{"error":"unauthorized"}`, zero payload |
| `POST_FIX_PRODUCTION_FINANCIAL_FINGERPRINT` | **8/8 baseline** |

### TELEGRAM_FALSE_POSITIVE_PROD_TEST

Challenge novo (mesma classe): `NORTE-PROD-VERIFY2-B631CFX265` — enviado
pelo dono ao bot.

| Evidência | Resultado |
|---|---|
| Vercel log | `POST /api/telegram/webhook → 200` (deploy `dpl_6V59Cu…`) |
| `getWebhookInfo` | `pending = 0`, `last_error = null` |
| `TelegramUpdateReceipt` | novo row `COMPLETED` (0,74 s) — transport secret ✓, `from.id` autorizado ✓, private chat ✓, idempotência ✓ |
| **`Expense` CREATE** | **0** (count 113, sum 10403,55 inalterados) |
| **`Income` / `Transfer` / `Purchase` / `ConfirmedCommitment` CREATE** | **0** |
| **`PendingBotMessage` financeiro** | **0** ✅ (e o resíduo pré-fix foi limpo) |
| Vercel 5xx | 0 |

`TELEGRAM_FALSE_POSITIVE_FIXED = YES`.

---

## GAP B — True Prod Mobile 390

Ferramenta: **puppeteer-core** (leve, sem Chromium empacotado) → **Chrome do
sistema** headless. Passphrase recuperada do Keychain **dentro do processo
controlador**, só em memória, digitada no DOM via `page.type` — nunca
impressa, nunca em arquivo, nunca em argumento de ferramenta. Sessão real
gerada pelo `POST /api/auth/login` (nenhum cookie forjado).

### VIEWPORT PROOF

CDP `Emulation.setDeviceMetricsOverride` (`page.setViewport({width:390,
height:844, deviceScaleFactor:2, isMobile:true, hasTouch:true})`):

| | |
|---|---|
| `window.innerWidth` | **390** |
| `document.documentElement.clientWidth` | **390** |

Produção real + auth Norte real + 390 **simultaneamente** — não mais
`prod-login-390 + DEV-auth-390`.

### Smoke (7 rotas, produção pública autenticada, 390)

| Rota | HTTP | innerWidth | overflow-x | conteúdo |
|---|---|---|---|---|
| `/` Hoje | 200 | 390 | **0** | "Apertado · -R$ 302,80 · …" |
| `/cartoes` Cartão | 200 | 390 | **0** | "FATURA ATUAL R$ 716,97 · uso 34% · disp. R$ 2.648,85" |
| `/compromissos` A pagar | 200 | 390 | **0** | "HORIZONTE ATUAL R$ 3.181,97 · …" |
| `/simulador` Simular | 200 | 390 | **0** | "Simulador · PIX ou dinheiro · …" |
| `/fluxo` Fluxo | 200 | 390 | **0** | "trajetória de caixa · 7/30/60/90/180d" |
| `/historico` Histórico | 200 | 390 | **0** | "ciclo 24/08–23/09 · por categoria" |
| `/metas` Metas | 200 | 390 | **0** | "Nenhuma meta ainda" |

- **`document.documentElement.scrollWidth == 390` em todas** → zero
  horizontal overflow.
- **bottom nav**: `Hoje · Cartão · A pagar · Simular` (links) + `Mais`
  (botão). Menu `Mais` → `Fluxo · Histórico · Metas`.
- **zero erro de console JS** nas 7 rotas.
- Único 4xx: `404 /favicon.ico` (cosmético — o app não tem favicon.ico; não
  afeta função/segurança/truth). Nenhum outro 4xx/5xx.
- **MOBILE FINANCIAL TRUTH**: `GET /api/dashboard` na sessão mobile →
  fingerprint **8/8 baseline**.
- `logout` → `/api/dashboard` depois → **401**.

`PRODUCTION_MOBILE_390_SMOKE_READY = YES`.

---

## Simulador (item 32)

Nenhum código do simulador mudou nesta fase. `FINAL_562` fingerprint
confirmado 8/8. Zero-persistence já provado (5.6.1.1 / 5.6.1.2 / 5.6 §12,
`zeroWriteProof: YES`).

## Logs (item 33)

Vercel runtime (100 eventos): **0 × 5xx**, **0 × error**, um único
deployment servindo (`dpl_6V59Cu…`). `getWebhookInfo` sem `last_error`,
`pending = 0`. Neon: 12/12 migrations, queries de auditoria sem erro.

`OBSERVABILITY_POST_CUTOVER_READY = YES`.

## Write accounting — Fase 5.6.2 (item 34)

| Classe | Qtd |
|---|---|
| `PRODUCTION_SCHEMA_WRITES` | **0** (12/12) |
| `PRODUCTION_RECONCILIATION_WRITES` | **0** |
| `EXPECTED_FINANCIAL_BUSINESS_WRITES` | **0** |
| `UNEXPECTED_FINANCIAL_BUSINESS_WRITES` | **0** (Expense 113 / sum 10403,55 · Income 13 / sum 17490,68 · todos os models inalterados) |
| `PRODUCTION_CONFIG_WRITES` | **0** |
| Permitidos ocorridos | 1 runtime deployment (`750d678`) · 1 `TelegramUpdateReceipt` do smoke · `LoginRateLimit` rows: 0 (limpas por logins válidos) |
| **`PendingBotMessage` financeiro (challenge)** | **0** ✅ (expected zero) |

## FINAL_562_PRODUCTION_FINANCIAL_FINGERPRINT

`unrestrictedCash 2879.17 · freeMoney -302.80 · safeToSpend 0 · status
APERTADO · nextIncomeBase 4937.18 · nextIncomeCommitment 2189.06 · va
587.23 · cardCurrentLiability 716.97` — **8/8**.

---

## Gates finais (item 36)

| Gate | |
|---|---|
| `PUBLIC_FINANCIAL_API_SECURE` | YES |
| `PUBLIC_APP_AUTH_READY` | YES |
| `RATE_LIMIT_PRODUCTION_READY` | YES (5.6 §10 — 429 autoritativo no DB) |
| `PRODUCTION_FINANCIAL_TRUTH_READY` | YES (8/8) |
| `TELEGRAM_TRANSPORT_READY` | YES |
| `TELEGRAM_AUTHORIZATION_READY` | YES (`from.id` + private chat) |
| `TELEGRAM_IDEMPOTENCY_READY` | YES (`updateId @unique`) |
| `TELEGRAM_INTENT_SAFETY_READY` | **YES** (root cause corrigido genericamente; false-positive corpus 20+ casos → zero candidato; prod test → zero write) |
| `TELEGRAM_PRODUCTION_READY` | YES |
| `PRODUCTION_MOBILE_390_SMOKE_READY` | **YES** (prod real + auth real + innerWidth 390, 7 rotas, zero overflow, truth 8/8) |
| `WEB_PRODUCT_READY` | YES |
| `OBSERVABILITY_POST_CUTOVER_READY` | YES |
| `SECURITY_INCIDENT_PERMANENTLY_CLOSED` | YES |

### FASE 5.6

**`FASE_5_6_PRODUCTION_CUTOVER_READY = YES`**
**`FASE_5_6_FORMALLY_CLOSED = YES`**

Todos os gates YES. Cutover público executado e verificado; reconciliação
financeira preservada 8/8; Telegram completo (transporte + auth + idempotência
+ intent safety); mobile 390 comprovado na produção real; nenhum write
financeiro inesperado em toda a fase; logs limpos; incidente de exposição
encerrado.

---

## STOP (item 38)

**PARADO.** Não iniciar nova evolução de produto nem próxima fase. Standard
Protection continua ativa; produção pública, protegida pela auth do Norte.
Aguardando revisão do dono.

### Git

`LOCAL_HEAD` = (este doc, local) sobre `750d678`. `ORIGIN_MAIN` = `750d678`
(fix de runtime pushado). `RUNTIME_PRODUCTION_COMMIT` = `750d678`.
