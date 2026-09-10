# Fase 5.6.1 — progresso do bootstrap de reconciliação

**Status: PARADO CONTIDO no dry-run.** Nenhum write em produção. Deployment
Protection = `all`. Dois blockers pra decisão do dono (seções F e G).

Nenhum valor real, nome pessoal, secret ou connection string neste documento.

## A. Ferramenta prod-safe (construída, sem duplicar código)

| Arquivo | Papel |
|---|---|
| `scripts/lib/assertProductionReconciliation.js` | Guard: exige 4 condições simultâneas — `DATABASE_ENV=production` + `NORTE_PRODUCTION_RECONCILIATION=561-approved` + `DATABASE_URL` contém o endpoint de produção esperado (passado pelo orquestrador via `neonctl`, nunca hardcoded) + NÃO estar num runtime Vercel. Nenhuma tem default. |
| `scripts/prod-bootstrap-loader.mjs` + `-register.mjs` | `resolve` hook do Node que remapeia `./lib/assertTestEnvironment.js` → `assertProductionReconciliation.js` **só** quando a flag da fase está setada. Roda os scripts de apply ORIGINAIS sem cópia/edição. |
| `scripts/bootstrap-production-reconciliation.mjs` | Orquestrador. Identity check + integridade da fonte + anchor pre/post + roda os 6 scripts na ordem de fase (dry-run sempre; `--apply` só com a flag). |

`BOOTSTRAP_TRANSACTION_MODEL = PHASED` — cada script de apply é 1
`prisma.$transaction` atômica + backup local. Se a fase N falha, 1..N-1
commitaram, N.. não rodaram; tudo idempotente → re-rodar retoma.

`PRODUCTION_WRITE_GUARD`: 4 flags. `DB_IDENTITY_GUARD`: o orquestrador (1)
compara o endpoint do connString com o de `neonctl connection-string production`,
(2) confirma que NÃO é o endpoint do branch `dev`, (3) conecta e exige 12
migrations + `current_setting('neon.branch_id')` == branch production.

## B. Gates verdes até agora

| Gate | Resultado |
|---|---|
| `IDENTITY_CHECK` | endpoint bate produção ✅, não é o dev ✅, `neon.branch_id` = production ✅, 12 migrations ✅ |
| `SNAPSHOT_INPUT_INTEGRITY` | `scripts/snapshot-input.local.json` presente, **gitignored**, 15187 bytes, sha256 `9d435bca989c…`, 9 external plans / 14 canonical VA expenses / 1 confirmed commitment / 1 contingency / `mainIncome.standardRecurringAmount` presente |
| `DEV_REFERENCE_CLEAN` | **YES** — 0 linha de teste sintético (LoginRateLimit, TelegramUpdateReceipt, Expense/Income/Account/Goal/Plan test-marked, Reserve/Receivable/CategoryBudget órfãos — tudo 0) |
| `PRE_BOOTSTRAP_BACKUP_CREATED` | **YES** — branch Neon `pre-bootstrap-2026-09-10` (`br-wandering-breeze-acfw2ny6`), parent `production` @ LSN `0/3681030` (pós-migration, pré-bootstrap), sem endpoint |
| `PRE_BOOTSTRAP_ANCHOR` | 12 migrations, Expense 106, BalanceAdjustment 3 (sum 749.56), RecurringRule 1, CardBill 16, CardLimitUpdate 1, todas as V2 tables = 0 |

## C. RECONCILIATION_SCRIPT_MAP

| # | Script | Fase | Escreve | Fonte | Idempotência |
|---|---|---|---|---|---|
| 1 | `seed-app-settings.mjs` | 3.2 | `AppSettings` (singleton) | constantes do script (`cycleStartDay`, `safetyMarginPercent`, cortes de histórico — já em `lib/settings.js`) | create-only, `findUnique` antes |
| 2 | `apply-fase51b-card-v2.mjs` | 5.1B | `Purchase` (mês), `CardBill` (UPDATE ×6, **DELETE ×1**), `Installment` (realinhamento de mês), `CardLimitUpdate` (CREATE ×1) | `snapshot-input.card` + `getCardCycleForDate` real | natural identity + preflight estrito + invariantes A-L |
| 3 | `apply-fase51c-va.mjs` | 5.1C | `Income` (UPDATE de conta/data), `Expense` (UPDATE de data/valor + **CREATE ×7**), `BalanceAdjustment` (CREATE ×1 — VA opening) | `snapshot-input.restrictedAccount` + `matchCanonicalExpenses` | dedup + "nunca 2ª opening anchor" + invariantes A-N |
| 4 | `apply-fase51d3-itau-snapshot.mjs` | 5.1D.3 | `BalanceAdjustment` (CREATE ×1 — Itaú authoritative snapshot) | `snapshot-input.checkingAccount.checkpointB` | dedup por `accountId+occurredAt+newBalance` |
| 5 | `apply-fase52c-obligations.mjs` | 5.2C | `RecurringRule` (CREATE ×1 salário), `ConfirmedCommitment` (×1), `ExternalInstallmentPlan` (×9) + `ExternalInstallment` (×38), `Contingency` (×1) | `snapshot-input.{mainIncome,confirmedCommitments,externalInstallmentPlans,contingencies}` | natural identity dos 4 grupos → NO_MUTATIONS_NEEDED |
| 6 | `apply-fase52d-va-rule.mjs` | 5.2D | `RecurringRule` (UPDATE ×1 — VA `dayOfMonth` 24→21) | `snapshot-input.restrictedAccount.recharge.date` | se já for 21 → NO_MUTATIONS_NEEDED |

Só `CREATE` e `UPDATE` de metadata/data, **exceto 1 DELETE** (seção F).
Nenhum `DELETE` de `Income`/`Expense`/`Transfer`/`Installment`.

## D. DRY-RUN #1 (parcial)

- **Script 2 (51B card) — dry-run exit 0.** Plano:
  - `Purchase.firstInstallmentMonth`: 2026-08 → 2026-09 (correção de ciclo, `getCardCycleForDate` real)
  - `CardBill` UPDATE (valor+metadata): 2026-09, 2026-10, 2026-11, 2027-02
  - `CardBill` UPDATE (metadata só): 2026-12, 2027-01
  - **`CardBill` DELETE: 2026-08** — ver seção F
  - `CardLimitUpdate` CREATE: `occurredAt=2026-09-04T23:59:59Z`, used=1378.15, available=2648.85
  - Invariantes A-L (simulados): **TODOS PASSARIAM**. `incurred: 2026-10 = 716.97` (= baseline `cardCurrentLiability`)
- **Scripts 3-6 — dry-run bloqueado** pela ordem: `AppSettings` não existe em produção, então `apply-fase51c-va` aborta ("`AppSettings.vaHistoryStart` não está setado"), e `52d` aborta ("`RecurringRule` de salário não encontrada" — vem do `52c`). Ver seção G.

## E. MISSING_MANUAL_EXPENSE_AUDIT (as 7 `Expense` que faltam em produção)

Não são "cópia cega do DEV". São o output determinístico de
`apply-fase51c-va.mjs` passo 5 (`missingToCreate`): as despesas canônicas de
VA (`snapshot-input.restrictedAccount.canonicalExpenses`, 14 itens) que o
`matchCanonicalExpenses` NÃO casa com nenhuma `Expense` existente → cria com
`accountId=VA, category="Alimentação", source="manual", confidence="CONFIRMED_BY_MEMORY"`.

| Critério (item 18) | Resultado |
|---|---|
| `SOURCE_PROVEN` | YES — `snapshot-input.local.json` (fonte aprovada da reconciliação), via o mesmo algoritmo do DEV |
| `NOT_SYNTHETIC` | YES — despesas reais de alimentação; DEV limpo de fixtures |
| `NOT_DUPLICATE` | YES — o script casa contra as existentes ANTES de criar |
| `REQUIRED_FOR_RECONCILIATION` | YES — o saldo de VA (587.23) não fecha sem elas; invariantes A-N do 51c falham se faltarem |

`CONFIDENCE_BACKFILL`: os mesmos 7 rows (criados já com `confidence=CONFIRMED_BY_MEMORY`) — não é um backfill separado.

## F. BLOCKER 1 — `CardBill` 2026-08 DELETE (item 33)

`apply-fase51b-card-v2` quer **deletar a `CardBill` de ciclo `2026-08`**.
Hoje em produção essa linha tem `totalAmount = 2004.39`, `status=closed`.

- **Por quê**: a correção de ciclo (`getCardCycleForDate`) move as
  `Installment` da `Purchase` de `2026-08` → `2026-09` (mês correto). O
  script **primeiro** faz esse shift, **depois** valida (invariantes A/D/E)
  que a `CardBill` `2026-08` ficou vazia (`remaining=0`, 0 installments),
  **então** deleta o container órfão.
- **O valor não some**: redistribui pelos ciclos corrigidos. DEV
  (reconciliado, aprovado) NÃO tem `CardBill` `2026-08`; tem
  `2026-09=1859.01, 2026-10=716.97, 2026-11=479.38, ...`. Produção hoje tem
  `2026-08=2004.39, 2026-09..2027-01=60.60`.
- **`CardBill` não é transação financeira** — é um container de período de
  fatura, derivado do ciclo do cartão. Nenhuma `Expense`/`Installment` é
  deletada (as installments são movidas, preservadas).

**Item 33 exige STOP em qualquer DELETE de row real. Preciso da sua decisão
explícita**: (a) aprovar este DELETE específico (parte da reconciliação 51B
já aprovada no DEV, invariantes verificam segurança), ou (b) você quer que
o `apply-fase51b` seja ajustado pra NÃO deletar (deixar a `CardBill`
`2026-08` órfã/vazia em produção).

## G. BLOCKER 2 — ordem: `AppSettings` é pré-requisito do dry-run completo

Os dry-runs de 51c/52c/52d só rodam com `AppSettings` já em produção
(precisam do ciclo/cutoffs pra computar). Num `--apply` real isso se
resolve sozinho (script 1 roda primeiro). Mas pra te dar o **dry-run
completo dos 6** antes de qualquer write financeiro, preciso da sua
autorização pra rodar **só o script 1** (`seed-app-settings`) como "fase 0":
1 row `AppSettings` (config: `cycleStartDay=24`, `safetyMarginPercent=10`,
`operationalHistoryStart=2026-08-24`, `vaHistoryStart=2026-08-21`), **zero
efeito financeiro** (não é dinheiro, não mexe em saldo/obrigação),
idempotente create-only. É exatamente o que rodou no DEV na Fase 3.2, muito
antes da reconciliação.

## Gates 5.6.1

| Gate | Estado |
|---|---|
| `PRODUCTION_RECONCILIATION_SOURCE_PROVEN` | YES (snapshot-input + scripts originais + DEV limpo) |
| `PRODUCTION_BOOTSTRAP_DRY_RUN_READY` | **NO** — parcial (só script 2) + blocker F |
| `PRODUCTION_RECONCILIATION_APPLIED` | NO |
| `PRODUCTION_FINANCIAL_TRUTH_READY` | NO |
| `PRE_BOOTSTRAP_BACKUP_CREATED` | YES |
| `UNEXPECTED_FINANCIAL_WRITES` | ZERO |
| `FASE_5_6_1_PRODUCTION_RECONCILIATION_READY` | **NO** |
