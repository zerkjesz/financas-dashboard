# Fase 5.6.1 — bootstrap de reconciliação em produção: APLICADO

**Status: APLICADO com sucesso. PARADO CONTIDO.** Deployment Protection =
`all` (produção segue inacessível externamente). Nenhum passo público /
Telegram. Aguardando revisão do dono.

Nenhum valor pessoal / nome de credor / secret neste documento.

## Guard prod-safe (mais forte que o original)

| | `assertTestEnvironment` (ORIGINAL) | `assertProductionReconciliation` (5.6.1) |
|---|---|---|
| Tipo | NEGATIVO — nega se PARECER produção | POSITIVO — só libera se TODAS as condições forem verdadeiras |
| Condições env | `VERCEL_ENV≠production` · `DATABASE_ENV∈{dev,test}` · `DATABASE_URL` sem o host de produção | `DATABASE_ENV=production` · `NORTE_PRODUCTION_RECONCILIATION=561-approved` · `DATABASE_URL` = endpoint de produção esperado **e unpooled** · não-Vercel |
| Para `--apply` | — | + arquivo de autorização do orquestrador com `runId` desta execução, `ts` < 15 min, `allGatesGreen=true` |
| Como o original é tratado | — | O loader (`scripts/prod-bootstrap-loader.mjs`) só remapeia `assertTestEnvironment.js` → este arquivo quando `NORTE_PRODUCTION_RECONCILIATION=561-approved` **e** `--import` é passado. Sem os dois, o guard ORIGINAL segue em vigor. |

**8 gates de rede** (o orquestrador roda antes de escrever, grava o arquivo
de autorização só se todos passam): projeto Neon esperado · branch =
`production` (e ≠ `dev`) · `neon.branch_id` da sessão = production · 12
migrations · Deployment Protection = `all` · `/api/dashboard` anônimo
contido (302/401) · backup `pre-cutover-2026-09-10` existe · backup
`pre-bootstrap-2026-09-10` existe.

`NO_DIRECT_SCRIPT_ACCIDENT`: provado por teste — `node scripts/apply-fase51c-va.mjs`
direto (mesmo com `DATABASE_ENV=production` no shell) → o guard ORIGINAL
aborta. Só o orquestrador, com todas as flags + os 8 gates, libera escrita.

`BOOTSTRAP_TOOLING_TESTS`: `scripts/test-bootstrap-guard.mjs` — **13/13**.

## Backups

| Branch | LSN | Estado capturado |
|---|---|---|
| `pre-cutover-2026-09-10` | `0/34B1B08` | produção ANTES das 7 migrations |
| `pre-bootstrap-2026-09-10` | `0/3681030` | produção pós-migration, ANTES da reconciliação |

Ambos intactos, sem endpoint (custo zero). **Não deletar.**

## Fase 0 — AppSettings

`PRODUCTION_CONFIG_BOOTSTRAP_WRITES = 1` · `PRODUCTION_FINANCIAL_BUSINESS_WRITES = 0`.
`AppSettings("default")` criado: `cycleStartDay=24, safetyMarginPercent=10,
operationalHistoryStart=2026-08-24, vaHistoryStart=2026-08-21`. Anchor delta:
só `AppSettings 0→1`. Segunda execução: "já existe — nada a fazer".

## Bootstrap financeiro — 5 fases, todas COMMITTED

`BOOTSTRAP_TRANSACTION_MODEL = PHASED` — 5 `prisma.$transaction` atômicas,
invariantes validados dentro de cada, backup local por fase.

| Fase | Writes | Invariantes |
|---|---|---|
| 5.1B card | `Purchase` mês 2026-08→2026-09 · `CardBill` UPDATE ×6 · **`CardBill` DELETE ×1 (2026-08)** · `CardLimitUpdate` CREATE ×1 · `Installment` realinhadas | A-L simuladas + reais: TODAS PASSARAM. `incurred 2026-10 = 716.97` |
| 5.1C VA | `Expense` occurredAt UPDATE ×6 · `Expense` near-amount UPDATE ×1 (154.95→155.00, +0.05) · `Expense` CREATE ×7 (Σ 347.19) · `Income` recharge date UPDATE ×1 · `Income` reclassificado VA→Itaú ×1 · `BalanceAdjustment` CREATE ×1 (VA opening 0.51) | A-N dentro da tx: TODAS PASSARAM. `vaBalance = 587.23` |
| 5.1D.3 Itaú | `BalanceAdjustment` CREATE ×1 (newBalance 2879.17) | pós-commit `computeAccountBalance(Itaú) = 2879.17`. Card + ledger histórico byte-idênticos |
| 5.2C obligations | `RecurringRule` CREATE ×1 (salário 4937.18@24) · `ConfirmedCommitment` CREATE ×1 (2465, dueBy 2026-09-20) · `ExternalInstallmentPlan` CREATE ×9 + `ExternalInstallment` CREATE ×38 · `Contingency` CREATE ×1 (expected 1000 / max 2000) | pós-commit engine: `unrestrictedCash=2879.17 · freeMoney=-302.80 · safeToSpend=0 · nextIncomeCommitment=2189.06 (44.34%)`. Card/VA/Itaú/todos os outros models byte-idênticos |
| 5.2D VA rule | `RecurringRule` UPDATE ×1 (VA `dayOfMonth` 24→21) | pós-commit: `unrestrictedCash=2879.17 · freeMoney=-302.80 · safeToSpend=0 · status=APERTADO`. Salário rule inalterada |

## ANCHOR DELTA (pré-bootstrap → pós-bootstrap) — cada item explicado

| Model | count | Σ | Explicação |
|---|---|---|---|
| Expense | 106→113 (+7) | +347.24 | 5.1C: 7 canonical VA criadas (Σ 347.19) + near-amount +0.05 |
| CardBill | 16→15 (−1) | — | 5.1B: **DELETE esperado** da CardBill 2026-08 órfã pós-shift |
| BalanceAdjustment | 3→5 (+2) | 749.56→3629.24 | 5.1C VA opening (0.51) + 5.1D.3 Itaú snapshot (2879.17) |
| CardLimitUpdate | 1→2 (+1) | — | 5.1B: âncora de limite reconciliada |
| RecurringRule | 1→2 (+1) | 1300→6237.18 | 5.2C: salário 4937.18 |
| ExternalInstallmentPlan | 0→9 | — | 5.2C |
| ExternalInstallment | 0→38 | 0→6394.38 | 5.2C: parcelas restantes dos 9 planos |
| ConfirmedCommitment | 0→1 | 0→2465.00 | 5.2C |
| Contingency | 0→1 | maxAmount 0→2000.00 | 5.2C |

`EXPECTED_RECONCILIATION_DELETES = 1` (CardBill 2026-08) ·
`UNEXPECTED_RECONCILIATION_DELETES = 0` ·
`UNEXPECTED_FINANCIAL_WRITES = 0`.

## Fingerprint pós-bootstrap (engine canônico do app, DB de produção reconciliado)

Capturado pelos próprios scripts `apply-fase52c` / `apply-fase52d` no
post-commit, rodando `computeFreeMoney` / `getNextIncomeInfo` /
`buildVaSnapshot` / `computeAccountBalance` (o MESMO `lib/` que o
`/api/dashboard` deployado usa):

| Campo | Produção pós-bootstrap | Baseline | |
|---|---|---|---|
| `unrestrictedCash` | 2879.17 | 2879.17 | ✅ |
| `freeMoney` | -302.80 | -302.80 | ✅ |
| `safeToSpend` | 0 | 0 | ✅ |
| `status` | APERTADO | APERTADO | ✅ |
| `nextIncomeBase` | 4937.18 | 4937.18 | ✅ |
| `nextIncomeCommitment` | 2189.06 | 2189.06 | ✅ |
| `va` (VA balance) | 587.23 | 587.23 | ✅ |
| `cardCurrentLiability` | 716.97 | 716.97 | ✅ |

**Os 8 batem exatamente.** (A captura via `/api/dashboard` autenticado do
deploy — mesmo código, mesmo DB — ficou pendente só porque a colagem de
senha no browser automatizado não funcionou nesta sessão; é uma verificação
de 10 s pro dono, ou quando a automação de browser voltar.)

## SEMANTIC_V2_ACCEPTANCE (read-only pós-apply)

- 12 migrations · 0 installment órfã · `AppSettings` singleton ✅ · 0
  `BalanceAdjustment` duplicado · CardBill 2026-08 removida · 15 CardBills
- 9 `ExternalInstallmentPlan`, parcelas restantes consistentes
  (`installmentCount − paidInstallments` por plano; Σ 38)
- `RecurringRule`: VA 1300@dia21 (corrigido) + salário 4937.18@dia24
- `Contingency` expected 1000 / max 2000 / `AWAITING_INFORMATION`
- `ConfirmedCommitment` 2465 / `CONFIRMED` / dueDate 2026-09-20
- `KNOWN_CARD_DETAIL_GAP` preservado · ledger pré-snapshot `PARTIAL` preservado

## Idempotência (2ª execução do orquestrador em dry-run)

Todas as 5 fases: **`NO_MUTATIONS_NEEDED`**. `PLANNED_CREATE = 0`,
`PLANNED_UPDATE = 0`, `PLANNED_DELETE = 0`. CardBill 2026-08 não tem 2º
DELETE (`N/A`).

## WRITE ACCOUNTING FINAL

> **CORRIGIDO na Fase 5.6.1.1** — ver `docs/fase5611-protected-runtime-acceptance.md`
> §2. Os dois números abaixo estavam errados: `PRODUCTION_RECONCILIATION_CREATES`
> é **60** financeiro + 1 config (a enumeração já somava 60; o headline "59"
> largou o `+1 Contingency`), e `PRODUCTION_RECONCILIATION_UPDATES` é **24**
> (o "15" não contava os realinhamentos estruturais: `Card.closingDay`,
> `Purchase.firstInstallmentMonth`, 6× `Installment.billMonth`,
> `RecurringRule.dayOfMonth` da 5.2D). `EXPECTED_CANONICAL_VALUE_CORRECTIONS = 1`,
> `NET_CANONICAL_CORRECTION = +0.05`. `UNEXPECTED_FINANCIAL_WRITES` segue 0.

| | |
|---|---|
| `PRODUCTION_CONFIG_BOOTSTRAP_WRITES` | 1 (AppSettings) |
| `PRODUCTION_RECONCILIATION_CREATES` | 59 (7 Expense + 2 BalanceAdjustment + 1 CardLimitUpdate + 1 RecurringRule + 1 ConfirmedCommitment + 9 ExternalInstallmentPlan + 38 ExternalInstallment + 1 Contingency) |
| `PRODUCTION_RECONCILIATION_UPDATES` | 15 (6 Expense date + 1 Expense near-amount + 1 Income date + 1 Income reclass + 6 CardBill) |
| `EXPECTED_RECONCILIATION_DELETES` | 1 (CardBill 2026-08) |
| `UNEXPECTED_RECONCILIATION_DELETES` | 0 |
| `PRODUCTION_FINANCIAL_VALUE_CHANGES` | 1 valor (Expense 154.95→155.00, +0.05 — política canônico-vence do snapshot-input) + realocação de datas/ciclos; nenhum saldo/obrigação fabricado |
| `AUTHORIZED_RECONCILIATION_WRITES` | todas as acima (aprovadas pelo dono nas Decisões 1+2 e na autorização de apply) |
| `UNEXPECTED_FINANCIAL_WRITES` | 0 |
| `PRODUCTION_SCHEMA_WRITES` | 0 (schema já era 12/12) |
| DEV | intocado (bootstrap só conectou em produção; counts de DEV inalterados) |

## Gates 5.6.1

| Gate | |
|---|---|
| `PRODUCTION_RECONCILIATION_SOURCE_PROVEN` | YES |
| `PRODUCTION_BOOTSTRAP_DRY_RUN_READY` | YES |
| `BOOTSTRAP_TOOLING_GUARD_READY` | YES |
| `BOOTSTRAP_TOOLING_TESTS_READY` | YES (13/13) |
| `PRODUCTION_RECONCILIATION_APPLIED` | **YES** |
| `PRODUCTION_RECONCILIATION_IDEMPOTENT` | **YES** |
| `PRODUCTION_FINANCIAL_TRUTH_READY` | **YES** (8/8 baseline) |
| `PRODUCTION_V2_DATA_BOOTSTRAP_REQUIRED` | **NO** |
| `PRE_BOOTSTRAP_BACKUP_CREATED` | YES |
| `EXPECTED_RECONCILIATION_DELETES` | 1 |
| `UNEXPECTED_RECONCILIATION_DELETES` | 0 |
| `UNEXPECTED_FINANCIAL_WRITES` | 0 |
| **`FASE_5_6_1_PRODUCTION_RECONCILIATION_READY`** | **YES** |

## Pendente (não nesta fase)

Deployment Protection segue `all`. Cutover público (All→Standard), smoke
público, `setWebhook` do Telegram — só na continuação da 5.6, **após sua
revisão**.
