# Fase 5.6.1.1 — Protected Runtime Acceptance + Audit Closure

**Status: FECHADA. PARADO CONTIDO.** Deployment Protection = `all` (produção
segue inacessível ao público). Nenhum passo `All → Standard`, nenhum
`setWebhook`, nenhum deploy novo, nenhum write financeiro em produção nesta
closure.

Nenhum valor pessoal, nome de credor, secret ou connection string neste
documento.

Base: HEAD `da88ec9` · origin/main `c5d2a91` (deploy `c5d2a91`,
`dpl_DqqnGtUgzJAgJ5nmRbfeLLB2UzQE`). Containment reconfirmado no início: anon
`GET /api/dashboard` → 302 (Deployment Protection).

---

## 1. LIVE AUTHENTICATED SMOKE (item 3–12) — EXECUTADO

Feito via Chrome real (sessão Vercel válida → passa o Deployment Protection).
Passphrase recuperada do Keychain (`security -s norte-dashboard-prod`) só pra
o clipboard do SO; colada no campo com um clique real seguido de `⌘V` (o
clique por coordenada dá foco de documento ao renderer — foi isso que
destravou o "Document is not focused" das sessões anteriores). A passphrase
nunca passou por argumento de ferramenta, log, relatório, arquivo ou commit.
Clipboard higienizado ao fim.

### Cadeia de autenticação

| Passo | Resultado |
|---|---|
| `POST /api/auth/login` (senha correta) | **200** |
| Redirect pós-login | `/` (dashboard) |
| Cookie de sessão visível a JS (`document.cookie`) | **vazio** → `HttpOnly` confirmado em runtime |
| `GET /api/dashboard` autenticado | **200** |
| `POST /api/auth/logout` | **200** → redirect `/login` |
| `GET /api/dashboard` pós-logout | **401** |

### Contrato do cookie (metadata, do código — `app/api/auth/login/route.js:94`)

`norte_session` · `HttpOnly` (verificado em runtime) · `Secure` =
`isProductionRuntime()` → **true** em produção · `SameSite=Lax` · `Path=/` ·
`Max-Age` = `SESSION_TTL_SECONDS` = 30 dias (`lib/auth/session.js:16`) ·
valor = token HMAC assinado com `SESSION_SECRET` (payload `iat`/`exp`).
Nenhum valor de token foi impresso.

### DEPLOYED_AUTHENTICATED_API_FINGERPRINT (`GET /api/dashboard` → 200, deploy `c5d2a91`, DB de produção reconciliado)

| Campo | Live autenticado | Baseline | |
|---|---|---|---|
| `unrestrictedCash` | 2879.17 | 2879.17 | ✅ |
| `freeMoney` | -302.80 | -302.80 | ✅ |
| `safeToSpend` | 0 | 0 | ✅ |
| `status` | APERTADO | APERTADO | ✅ |
| `nextIncomeBase` | 4937.18 | 4937.18 | ✅ |
| `nextIncomeCommitment` | 2189.06 | 2189.06 | ✅ |
| `vaBalance` | 587.23 | 587.23 | ✅ |
| `cardCurrentLiability` (`incurredLiabilities`) | 716.97 | 716.97 | ✅ |

**8/8 batem exatamente.** `statusReasons` = `FREE_MONEY_NEGATIVE`
(coerente). Este é o fingerprint que a 5.6 / 5.6.1 deixaram pendente — agora
capturado end-to-end pelo produto deployado, autenticado, contra o banco de
produção.

### Semântica V2 ao vivo (páginas protegidas)

- **Início**: Situação `Apertado`, Dinheiro livre `-R$ 302,80`, Seguro pra
  gastar `R$ 0,00`, Próxima renda `R$ 4.937,18` @ 24/09 (44%), Já
  comprometido `R$ 2.189,06`, compromisso `Tattoo R$ 2.465,00` até 20/09.
- **Cartão** (`/cartoes`): Fatura atual `R$ 716,97` (ciclo 2026-10, vence
  11/10), uso do limite `34%` = `R$ 1.378,15 / R$ 4.027,00`, disponível
  `R$ 2.648,85`, próximas faturas `2026-11 = R$ 479,38`, `2026-12 = R$ 60,60`.
  Todos batem o fingerprint canônico.
- **Compromissos** (`/compromissos`): Horizonte atual `R$ 3.181,97`
  (716,97 + 2.465,00), Sai da próxima renda `R$ 2.189,06`, **9 planos de
  parcela externa** listados (`R$ 1.472,09` na janela), Tattoo `R$ 2.465,00`,
  contingência `Tiger` presente.
- **Simulador** (`/simulador`): `POST /api/simulate` → 200. Cenário
  `R$ 500` PIX → "Cabe, mas aperta o orçamento" / situação simulada
  `Crítico` / Dinheiro livre `-R$ 302,80 → -R$ 802,80 (-R$ 500,00)` —
  determinístico.
- `/fluxo`, `/historico`, `/metas`: `200`, renderizam, sem erro de console.
- `/api/dashboard`, `/api/cards/{id}/bills`, `/api/purchases` → 200.

### Simulador — zero persistência (item 28)

Fingerprint de contagem/saldo **antes** de simular:
`{entries:126, upcomingObligations:14, freeMoney:-302.8, accounts:[2879.17,0,587.23]}`.
**Depois** de `POST /api/simulate` (R$ 500): **idêntico** (`identical: true`).
`PRODUCTION_FINANCIAL_BUSINESS_WRITES` nesta closure = **0**.

### Mobile

Janela reduzida (o Chrome tem piso ~500 px de largura de conteúdo; não deu
pra chegar a 390 real). A 500 px: barra de navegação inferior com ícones
engaja (`Hoje / Cartão / A pagar / Simular / Mais`), cards empilham,
`document.documentElement.scrollWidth (492) ≤ innerWidth (500)` →
**sem overflow horizontal**.

`LIVE_AUTHENTICATED_SMOKE = PASS` · `DEPLOYED_AUTHENTICATED_API_FINGERPRINT = 8/8`

---

## 2. WRITE ACCOUNTING — RECONCILIADO (itens 13–19)

### Contrato de contagem

- **CREATE** = linha nova inserida por um `INSERT` em qualquer fase.
- **UPDATE** = linha existente que teve **≥ 1 coluna escrita** por um
  `UPDATE` em qualquer fase (conta a linha uma vez mesmo se tocada em >1
  fase; nenhuma linha foi tocada em 2 fases).
- **DELETE** = linha removida.
- "Config" (AppSettings) é contado separado de "financeiro".

### Tabela por model — pre-bootstrap → pós-bootstrap

Fonte: backups locais por fase (`scripts/snapshot-reports/*-1789069*`), que
são a captura autoritativa BEFORE/AFTER de cada `prisma.$transaction`.

| Model | Antes | Criadas | Atualizadas | Deletadas | Depois |
|---|---:|---:|---:|---:|---:|
| AppSettings | 0 | 1 *(config)* | 0 | 0 | 1 |
| Card | 1 | 0 | 1 | 0 | 1 |
| Purchase | 1 | 0 | 1 | 0 | 1 |
| Installment | 6 | 0 | 6 | 0 | 6 |
| CardBill | 16 | 0 | 6 | **1** | 15 |
| CardLimitUpdate | 1 | 1 | 0 | 0 | 2 |
| Expense | 106 | 7 | 7 | 0 | 113 |
| Income | 13 | 0 | 2 | 0 | 13 |
| BalanceAdjustment | 3 | 2 | 0 | 0 | 5 |
| RecurringRule | 1 | 1 | 1 | 0 | 2 |
| ConfirmedCommitment | 0 | 1 | 0 | 0 | 1 |
| ExternalInstallmentPlan | 0 | 9 | 0 | 0 | 9 |
| ExternalInstallment | 0 | 38 | 0 | 0 | 38 |
| Contingency | 0 | 1 | 0 | 0 | 1 |
| **TOTAL financeiro** | | **60** | **24** | **1** | |
| **TOTAL config** | | **1** | 0 | 0 | |

### Por fase

| Fase | CREATE | UPDATE | DELETE |
|---|---|---|---|
| 0 AppSettings | 1 config | — | — |
| 5.1B card | 1 (CardLimitUpdate) | 14 = 1 Card `closingDay` null→4 + 1 Purchase `firstInstallmentMonth` 2026-08→09 + 6 CardBill (`closesAt`/`dueAt` + total re-derivado) + 6 Installment `billMonth` realinhado | **1 (CardBill 2026-08)** |
| 5.1C VA | 8 = 7 Expense (Σ 347.19) + 1 BalanceAdjustment (VA opening 0.51) | 9 = 6 Expense `occurredAt` + 1 Expense 154.95→155.00 + 1 Income `occurredAt` (recarga) + 1 Income `accountId` VA→Itaú | 0 |
| 5.1D.3 Itaú | 1 (BalanceAdjustment snapshot 2879.17) | 0 | 0 |
| 5.2C obrigações | 50 = 1 RecurringRule (salário) + 1 ConfirmedCommitment + 9 ExternalInstallmentPlan + 38 ExternalInstallment + 1 Contingency | 0 | 0 |
| 5.2D VA rule | 0 | 1 (RecurringRule VA `dayOfMonth` 24→21) | 0 |

### Por que o relatório disse "59" (item 15)

A **enumeração** do relatório (`fase561-bootstrap-complete.md` linha 123) já
listava os termos certos: `7 + 2 + 1 + 1 + 1 + 9 + 38 + 1`. Some:
`7+2=9 → 10 → 11 → 12 → 21 → 59 → 60`. O headline "59" **largou o último
termo** (`+1 Contingency`) na hora de somar — parou em 59 (o subtotal logo
após as 38 `ExternalInstallment`). Não é ajuste "por conveniência": as
partes já estavam certas, só a adição final do cabeçalho estava errada.

**EXACT_CREATE_TOTAL = 60** (financeiro) + 1 (config). Não 59.

### Por que o relatório disse "15" updates

O "15" (`6 Expense date + 1 Expense near-amount + 1 Income date + 1 Income
reclass + 6 CardBill`) contou só as reclassificações de valor/data em
`Expense`/`Income`/`CardBill`. **Omitiu** UPDATEs estruturais que também são
`UPDATE`:

| Omitido | Linhas |
|---|---|
| `Card.closingDay` null→4 | 1 |
| `Purchase.firstInstallmentMonth` 2026-08→09 | 1 |
| `Installment.billMonth` realinhado | 6 |
| `RecurringRule.dayOfMonth` VA 24→21 (fase 5.2D) | 1 |

`15 + 1 + 1 + 6 + 1 = 24`. **PRODUCTION_RECONCILIATION_UPDATES = 24.**

### Sub-classificação dos 24 UPDATEs

| Classe | Linhas | Dinheiro novo? |
|---|---:|---|
| Alteração de valor monetário em registro econômico | **1** (Expense 154.95→155.00) | **+0.05** |
| Reclassificação de conta (Income VA→Itaú) | 1 | não (move, não cria) |
| Realinhamento de data/ciclo (6 Expense `occurredAt`, 1 Income `occurredAt`, 6 CardBill, 6 Installment `billMonth`, 1 Purchase `firstInstallmentMonth`) | 20 | não |
| Config de cartão (`closingDay`) | 1 | não |
| Agenda de regra (`RecurringRule.dayOfMonth`) | 1 | não |

Os 6 UPDATEs de `CardBill.totalAmount` **não** injetam dinheiro: `CardBill`
é container derivado (soma de `Expense` + `Installment` na janela do ciclo
corrigido); os registros econômicos por baixo não mudam de valor (exceto o
único +0.05). O total do cartão (`Purchase.totalAmount = 363.60`) é
conservado.

### Correções de valor canônico (itens 16–17)

`EXPECTED_CANONICAL_VALUE_CORRECTIONS = 1` · `NET_CANONICAL_CORRECTION = +0.05`
(Expense 154.95 → 155.00, política "canônico vence" do `snapshot-input`,
pré-aprovada). Nenhum outro valor monetário de registro econômico foi
alterado.

`NET_ECONOMIC_VALUE_INJECTED_BY_UPDATES = +0.05`.
Dinheiro introduzido por CREATE (por design — são os registros que faltavam,
todos aprovados nas Decisões 1+2 + autorização de apply): 7 Expenses de VA
(Σ 347.19); 2 âncoras `BalanceAdjustment` (estado observado, não transação:
VA 0.51, Itaú 2879.17); 1 âncora `CardLimitUpdate`; registros de obrigação
da 5.2C (prospectivos, não movimento de saldo).

### Deltas — todos explicados

`UNEXPECTED_RECONCILIATION_DELETES = 0` · `UNEXPECTED_FINANCIAL_WRITES = 0` ·
`EXPECTED_RECONCILIATION_DELETES = 1`. Nenhum delta sem explicação → **sem
STOP CONTIDO** por esse critério.

---

## 3. AUTHORIZATION ARTIFACT LIFECYCLE (itens 20–24)

### Antes (5.6.1)

O orquestrador gravava `scripts/lib/.bootstrap-authorized.json` **uma vez**,
antes do loop de fases, e só apagava no `finally`. Válido por até **15 min**,
reutilizável por qualquer subprocesso `--apply` daquela execução enquanto o
loop rodava. Item 22: "se permanece válido por até 15 minutos: corrigir
tooling."

### Depois (5.6.1.1) — single-use, por fase

`scripts/bootstrap-production-reconciliation.mjs`:

- Sem `writeAuth` pré-loop. Guarda só `AUTH_GATES_GREEN` em memória após os 8
  gates.
- Em `runScript`, **só no modo `--apply`**: gera `nonce` novo
  (`crypto.randomUUID()`), grava o arquivo com
  `{ runId, phase, nonce, ts, allGatesGreen }` **imediatamente antes** de
  spawnar o subprocesso da fase, e **apaga no `finally`** (logo após a fase
  terminar — sucesso ou falha). Passa `NORTE_BOOTSTRAP_PHASE` +
  `NORTE_BOOTSTRAP_NONCE` no env do subprocesso.
- Dry-run **nunca** grava o arquivo.

`scripts/lib/assertProductionReconciliation.js` (guard, bloco `if (isApply)`):
exige, além de `runId`:

- `NORTE_BOOTSTRAP_PHASE` do env == `auth.phase` (autorização é de UMA fase);
- `NORTE_BOOTSTRAP_NONCE` do env == `auth.nonce` (single-use);
- `Date.now() - auth.ts ≤ 60 000` (janela de 60 s, era 15 min);
- `auth.allGatesGreen === true`.

### Respostas (itens 20–21)

| | |
|---|---|
| `AUTH_ARTIFACT_LOCATION` | `scripts/lib/.bootstrap-authorized.json` (gitignored, `.gitignore:18`) |
| `PERSISTED_AFTER_RUN` | **NO** — apagado no `finally` de cada fase e de novo no `finally` do `main()` e no `.catch` |
| `CURRENTLY_VALID` | **NO** — arquivo não existe; verificado (`ls` → No such file) |
| `REUSABLE` | **NO** — nonce single-use + janela de 60 s + amarrado a `runId` + `phase` |
| `SINGLE_USE` | **YES** — nonce consumido/deletado assim que a fase termina |
| `INVALIDATED` | **YES** (por construção, a cada fase) |

### Failure recovery

A janela de 60 s cobre o spawn + execução de UMA fase (as fases mais longas
— 5.2C, 38 `ExternalInstallment` — rodam em ~2–3 s). Se uma fase falhar no
meio, o arquivo é apagado no `finally`; re-rodar o orquestrador gera novo
`RUN_ID` + novos nonces e refaz os 8 gates (as fases já commitadas são
idempotentes → `NO_MUTATIONS_NEEDED`). Não há estado preso.

### Tooling tests (item 24) — `scripts/test-bootstrap-guard.mjs`

**19/19** (era 13/13). Novos / reforçados:

| # | Prova |
|---|---|
| [9] | autorização expirada **> 60 s** → ABORT |
| [9b] | autorização de 30 s (dentro da janela) → passa (recovery preservado) |
| [11] | autorização válida (`runId`+`phase`+`nonce`+`ts`+gates) → passa |
| [11b] | **single-use: 1ª execução passa, 2ª execução (arquivo consumido) → ABORT** |
| [11c] | autorização de **outra fase** → ABORT |
| [11d] | `nonce` != autorização → ABORT |
| [11e] | sem `NORTE_BOOTSTRAP_NONCE` no env → ABORT |
| [12] | `node scripts/apply-*.mjs` direto (sem loader) + `DATABASE_ENV=production` → guard ORIGINAL aborta |

### `NO_DIRECT_SCRIPT_ACCIDENT` reconfirmado (item 23)

End-to-end: `node --import ./scripts/prod-bootstrap-loader-register.mjs
scripts/apply-fase52d-va-rule.mjs --apply` com todas as env de produção
setadas **mas sem o orquestrador** → `exit 1`, "`--apply` exige autorização
do orquestrador (arquivo ausente)", nenhum arquivo criado.

---

## 4. Regressão (itens 25–27)

| Check | Resultado |
|---|---|
| `node --check` nos 3 arquivos de tooling alterados | OK |
| `npx prisma validate` | válido |
| `npm run build` | **sucesso** (todas as rotas compilam, middleware 35 kB) |
| `scripts/test-bootstrap-guard.mjs` | **19/19** |

Os arquivos alterados (`assertProductionReconciliation.js`,
`bootstrap-production-reconciliation.mjs`, `test-bootstrap-guard.mjs`) **não
são importados por nada** além do próprio orquestrador de bootstrap e do seu
teste — não tocam o runtime do app nem os outros ~43 testes. O produto
deployado (`c5d2a91`) não mudou.

### Fingerprints (item 27)

| Fonte | 8 valores | |
|---|---|---|
| Engine-direto (scripts `apply-fase52c`/`52d` pós-commit, `lib/` canônico) | 2879.17 / -302.80 / 0 / APERTADO / 4937.18 / 2189.06 / 587.23 / 716.97 | ✅ baseline |
| **Live autenticado** (`GET /api/dashboard` do deploy, sessão real) | idem | ✅ baseline |

Os dois caminhos, mesmo código e mesmo DB, dão o mesmo resultado.

---

## 5. Gates finais 5.6.1.1

| Gate | |
|---|---|
| `PROTECTED_CONTAINMENT_STILL_ACTIVE` | YES (Deployment Protection = `all`, anon → 302) |
| `LIVE_AUTHENTICATED_SMOKE` | **YES** (login 200 → dashboard 200 → logout → 401) |
| `DEPLOYED_AUTHENTICATED_API_FINGERPRINT` | **8/8** = baseline |
| `SESSION_COOKIE_CONTRACT_VERIFIED` | YES (HttpOnly em runtime; Secure/Lax/Path/30d do código) |
| `SIMULATOR_ZERO_PERSISTENCE` | YES (`identical: true`) |
| `PRODUCTION_FINANCIAL_BUSINESS_WRITES` (esta closure) | **0** |
| `WRITE_ACCOUNTING_RECONCILED` | YES |
| `EXACT_CREATE_TOTAL` | **60** financeiro + 1 config (relatório dizia 59 — erro de soma do headline) |
| `PRODUCTION_RECONCILIATION_UPDATES` | **24** (relatório dizia 15 — não contava realinhamentos estruturais) |
| `EXPECTED_CANONICAL_VALUE_CORRECTIONS` | 1 |
| `NET_CANONICAL_CORRECTION` | +0.05 |
| `UNEXPECTED_FINANCIAL_WRITES` | 0 |
| `UNEXPECTED_RECONCILIATION_DELETES` | 0 |
| `AUTH_ARTIFACT_PERSISTED_AFTER_RUN` | **NO** |
| `AUTH_ARTIFACT_SINGLE_USE` | **YES** (nonce + fase + janela 60 s) |
| `BOOTSTRAP_TOOLING_TESTS` | **19/19** |
| `NO_DIRECT_SCRIPT_ACCIDENT` | reconfirmado (end-to-end) |
| `BUILD` | passa |
| **`FASE_5_6_1_PRODUCTION_RECONCILIATION_READY`** | **YES** |

---

## 6. STOP CONTIDO (item 32)

Deployment Protection continua `all`. **Não** foi feito: `All → Standard`;
`setWebhook`; Telegram production; deploy novo; bootstrap financeiro
adicional. Aguardando a sua última revisão antes de tornar o Norte público
(continuação da 5.6).

### Observação (fora de escopo desta closure)

`/cartoes` mostra a fatura do ciclo `2026-10` com "vence 11/10/2026". Com
`closingDay = 4` o vencimento correto seria ~09–11/10 conforme a regra do
cartão — é o `computeDueAt` legado (P1-3 da auditoria), já previsto pra Fase
5 do plano de implementação, **junto** com o preenchimento do `closingDay`.
Não afeta nenhum dos 8 valores canônicos (o fingerprint usa `cycleMonth`, não
`dueAt`). Registrado, não corrigido aqui.
