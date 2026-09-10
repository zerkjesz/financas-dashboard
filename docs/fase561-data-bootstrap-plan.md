# Fase 5.6.1 — Bootstrap dos dados de reconciliação em produção

**Status: BLOQUEADO / CONTIDO.** O cutover de código+schema (5.6) foi feito
e verificado, mas o **fingerprint financeiro autenticado de produção NÃO
bate com o baseline aprovado**. Causa: a reconciliação financeira das Fases
5.1–5.2 foi aplicada apenas no branch **DEV**, nunca em produção.

**Deployment Protection permanece `all` (produção contida).** Nada de
bootstrap foi executado.

Nenhum valor pessoal / nome de credor / secret aparece neste documento.

## Prova do mismatch

Login válido end-to-end em produção (passphrase do keychain, via Chrome do
dono, atrás da Deployment Protection): `POST /api/auth/login` → 200 →
sessão → Home → `GET /api/dashboard` → 200 → logout → 401. **A auth
funciona.** Mas o snapshot financeiro:

| Campo | Produção (agora) | Baseline aprovado |
|---|---|---|
| `unrestrictedCash` | 4364.81 | 2879.17 |
| `freeMoney` | 2360.42 | -302.80 |
| `safeToSpend` | 2124.38 | 0 |
| `status` | TRANQUILO | APERTADO |
| `nextIncomeBase` | **null** (FALLBACK) | 4937.18 |
| `nextIncomeCommitment` | 60.60 | 2189.06 |
| `va` | 955.96 | 587.23 |
| `cardCurrentLiability` | 2004.39 | 716.97 |

`INNER_APP_AUTH_READY = YES` · `PRODUCTION_FINANCIAL_TRUTH_READY = NO` ·
`PRODUCTION_V2_DATA_BOOTSTRAP_REQUIRED = YES`.

## Delta DEV ↔ PROD (o que falta em produção)

DEV está limpo (0 linha de teste sintético em qualquer model — verificado).
Todo o delta abaixo é dado real de reconciliação aplicado só no DEV:

| Model | DEV | PROD | Falta em PROD | Script que criou no DEV |
|---|---|---|---|---|
| `AppSettings` | 1 | 0 | ciclo=24, margem=10%, `operationalHistoryStart`=2026-08-23, `vaHistoryStart`=2026-08-20 | `scripts/seed-app-settings.mjs` |
| `RecurringRule` | 2 | 1 | +1: salário base (4937.18 @ dia 24) — PROD só tem a regra de VA | `scripts/apply-fase52c-obligations.mjs` |
| `BalanceAdjustment` | 5 | 3 | +2: Itaú → 2879.17 (2026-09-04); VA → 0.51 (2026-08-20) | `apply-fase51d3-itau-snapshot.mjs` + `apply-fase51c-va.mjs` |
| `CardLimitUpdate` | 2 | 1 | +1: âncora de limite reconciliada | `apply-fase51b-card-v2.mjs` |
| `ExternalInstallmentPlan` | 9 | 0 | +9 planos de parcela externa reais (`dueTiming=AFTER_NEXT_INCOME`) | `apply-fase52c-obligations.mjs` |
| `ExternalInstallment` | 38 | 0 | +38 parcelas (filhas dos 9 planos) | idem |
| `ConfirmedCommitment` | 1 | 0 | +1 compromisso confirmado (janela incerta) | idem |
| `Contingency` | 1 | 0 | +1 contingência/risco | idem |
| `Expense` | 113 | 106 | +7 (`source='manual'`) — despesas adicionadas na reconciliação | manual, durante 5.1–5.2 |
| `Expense.confidence` | 7 preench. | 0 | backfill de confiança em 7 linhas | backfill 5.3 |

Efeito de cada gap:
- **`AppSettings` + `RecurringRule` salário ausentes** → o motor não resolve
  a próxima renda → `nextIncomeBase=null`, `status=FALLBACK`. É a causa raiz
  do "TRANQUILO" errado.
- **`BalanceAdjustment` Itaú ausente** → produção mostra o saldo antigo
  (4364.81) em vez do reconciliado (2879.17).
- **`BalanceAdjustment` VA ausente** → VA 955.96 em vez de 587.23.
- **9 `ExternalInstallmentPlan` ausentes** → `nextIncomeCommitment.externalAmount=0`
  (deveria ser 1472.09) → `committedAmount` 60.60 em vez de 2189.06.
- **`ConfirmedCommitment` + `Contingency` ausentes** → `freeMoney` não
  desconta obrigações futuras → +2360 em vez de −302.

## Como o DEV foi reconciliado (fatos)

6 scripts `scripts/apply-*.mjs` + `seed-app-settings.mjs`, rodados na ordem
de fase contra o branch DEV, lendo `scripts/snapshot-input.local.json`
(gitignored, 15 KB — a fonte-de-verdade da reconciliação, presente no
disco). Todos:
- têm `assertTestEnvironment()` (abortam se `DATABASE_ENV` não for
  `development`/`test`) → **não rodam contra produção como estão**;
- suportam `--dry-run`;
- são **idempotentes** (checam "já aplicado?" e param com `NO_MUTATIONS_NEEDED`);
- gravam backup local antes de mutar (`scripts/*-backups/pre-*-apply-*.local.json`).

## Opções de bootstrap (decisão do dono)

### Opção A — variantes prod-safe dos apply scripts (recomendada)
Para cada script, criar `apply-*-PROD.mjs` que troca `assertTestEnvironment()`
por um guard explícito de cutover (flag deliberada + confirmação de que o
`DATABASE_URL` é o endpoint `production` do Neon + backup obrigatório).
Manter `--dry-run` e os backups. Sequência:
1. Snapshot Neon `pre-bootstrap-<data>` do branch produção.
2. `--dry-run` de cada script contra produção, revisar o relatório.
3. Rodar de verdade, na ordem: `seed-app-settings` → `apply-fase51b-card-v2`
   → `apply-fase51c-va` → `apply-fase51d3-itau-snapshot` →
   `apply-fase52c-obligations` → `apply-fase52d-va-rule`.
4. Re-capturar o fingerprint autenticado de produção → deve bater os 8
   valores do baseline.
- **Prós**: usa exatamente a lógica auditada+testada que produziu o DEV;
  idempotente; backup por script; `snapshot-input.local.json` já é a fonte.
- **Contras**: precisa escrever os guards prod-safe; precisa rodar com o
  `DATABASE_URL` de produção (secret) num subprocesso sem persistir.

### Opção B — sync seletivo de linhas do branch DEV → PROD
Exportar exatamente as linhas do delta (com IDs/relações preservadas) do
branch DEV e inserir no PROD.
- **Prós**: cirúrgico; DEV é a verdade aprovada e está limpo.
- **Contras**: relações (`ExternalInstallment.planId`, `confidence` FKs,
  `BalanceAdjustment.accountId`) exigem cuidado; mais frágil que A.

### Opção C — restaurar o DADO de produção a partir do branch DEV
`neonctl branches restore` production ← dev (só dado; schema já é igual,
ambos em 12 migrations).
- **Prós**: traz a verdade reconciliada inteira de uma vez.
- **Contras**: sobrescreve TUDO em produção (incluindo qualquer coisa que
  só exista em prod); o histórico `_prisma_migrations` de DEV difere; risco
  de arrastar estado transitório de DEV. **Mais arriscado.**

**Recomendação: Opção A.**

## O que NÃO fazer

- Não retirar a Deployment Protection enquanto o fingerprint não bater.
- Não "ajustar número" manualmente no banco.
- Não rodar os apply scripts atuais contra produção (guard de ambiente).
- Não configurar o webhook do Telegram antes do bootstrap + gate financeiro.

## Estado preservado do cutover 5.6 (não regride)

- Produção: schema 12/12, código `c5d2a91` deployado/promovido, inner auth
  verificada, `PRODUCTION_FINANCIAL_WRITES` das migrations = ZERO (só
  transformação de tipo Float→Decimal, 0 valor alterado).
- `origin/main = c5d2a91`. Backup `pre-cutover-2026-09-10` intacto.
- Deployment Protection = `all` (contido).
