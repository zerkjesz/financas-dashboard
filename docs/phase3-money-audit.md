# Fase 3.0 — Auditoria monetária pré-Decimal

Status: **diagnóstico concluído, nenhuma mudança de schema/dado feita**. Rodado
contra o branch `dev` do Neon (dados reais, cópia de produção no momento em que o
branch foi criado). `prisma/schema.prisma` intocado, nenhuma migration criada,
nenhum dado alterado, nenhum deploy.

---

## 1. Inventário completo dos campos monetários

Todo campo `Float` do schema atual é dinheiro — **nenhum Float não-monetário
encontrado** (nenhum percentual/score/índice é persistido; percentuais como
`percentualSalarioComprometido` são sempre calculados em memória, nunca
guardados no banco). 17 campos ao todo:

| Model.campo | Uso | Nullable | Default | Registros (linhas) | Não-nulos |
|---|---|---|---|---|---|
| `Card.totalLimit` | limite total do cartão | não | — | 1 | 1 |
| `Income.amount` | valor da receita | não | — | 13 | 13 |
| `Expense.amount` | valor do gasto | não | — | 106 | 106 |
| `Transfer.amount` | valor movido entre conta/cartão | não | — | 0 | 0 |
| `BalanceAdjustment.newBalance` | âncora de saldo declarado | não | — | 3 | 3 |
| `CardLimitUpdate.newTotalLimit` | âncora de limite total (se mudou) | **sim** | — | 1 | 1 |
| `CardLimitUpdate.newUsedLimit` | âncora de limite usado | não | — | 1 | 1 |
| `CardLimitUpdate.reportedAvailable` | valor bruto informado (auditoria) | **sim** | — | 1 | 1 |
| `Purchase.totalAmount` | valor total da compra parcelada | não | — | 1 | 1 |
| `Purchase.installmentValue` | valor de cada parcela | não | — | 1 | 1 |
| `Installment.amount` | valor de uma parcela específica | não | — | 6 | 6 |
| `CardBill.totalAmount` | total da fatura no ciclo | não | `0` | 16 | 16 |
| `CardBill.paidAmount` | quanto já foi pago dessa fatura | **sim** | — | 16 | 0 |
| `RecurringRule.amount` | valor da recorrência (null = variável) | **sim** | — | 1 | 1 |
| `Bill.amount` | valor da conta a pagar | não | — | 0 | 0 |
| `Goal.targetAmount` | valor alvo da meta | não | — | 0 | 0 |
| `Goal.savedAmount` | valor já guardado na meta | não | `0` | 0 | 0 |

Min/max/negativos por campo (só os com dado — os 5 campos com 0 registros não-nulos
não têm o que medir ainda) estão na seção 2, junto com o relatório de precisão —
são a mesma passada de leitura, não faz sentido separar.

**Todos os 17 recomendo converter pra `Decimal(12,2)`** — não existe nenhum caso
aqui que devesse continuar `Float` (não há percentual/score/índice armazenado).

---

## 2. Relatório read-only Float → ROUND(2) — resultado real (branch dev)

Script: [`scripts/audit-money-precision.js`](../scripts/audit-money-precision.js)
(novo, 100% read-only — ver seção 9). Rodado agora contra o branch `dev`:

| Campo | min | max | negativos | registros que mudariam c/ ROUND(2) |
|---|---|---|---|---|
| `Card.totalLimit` | 4.027,00 | 4.027,00 | 0 | **0** |
| `Income.amount` | 22,00 | 4.937,18 | 0 | **0** |
| `Expense.amount` | 0,50 | 1.000,00 | 0 | **0** |
| `BalanceAdjustment.newBalance` | 0,00 | 749,56 | 0 | **0** |
| `CardLimitUpdate.newTotalLimit` | 4.027,00 | 4.027,00 | 0 | **0** |
| `CardLimitUpdate.newUsedLimit` | 2.262,95 | 2.262,95 | 0 | **0** |
| `CardLimitUpdate.reportedAvailable` | 1.764,05 | 1.764,05 | 0 | **0** |
| `Purchase.totalAmount` | 363,60 | 363,60 | 0 | **0** |
| `Purchase.installmentValue` | 60,60 | 60,60 | 0 | **0** |
| `Installment.amount` | 60,60 | 60,60 | 0 | **0** |
| `CardBill.totalAmount` | 0,00 | 2.004,39 | 0 | **0** |
| `RecurringRule.amount` | 1.300,00 | 1.300,00 | 0 | **0** |
| `Transfer.amount` | — | — | — | sem dado (0 linhas) |
| `CardBill.paidAmount` | — | — | — | sem dado (0 não-nulos, 16 linhas todas null) |
| `Bill.amount` | — | — | — | sem dado (0 linhas) |
| `Goal.targetAmount` / `savedAmount` | — | — | — | sem dado (0 linhas) |

**Resposta direta à pergunta do item 2**: sim, digo explicitamente — **todos os
registros que existem hoje já têm exatamente 2 casas decimais**. Soma antes e
soma depois do `ROUND(2)` são idênticas em todo campo com dado. Maior diferença
encontrada: **zero** (não há um único registro, em nenhum dos 17 campos, onde
`ROUND(2)` mudaria o valor armazenado). Nenhum exemplo de maior diferença a
listar, porque não houve diferença nenhuma.

Isso é uma boa notícia pra migration: a conversão `Float -> NUMERIC(12,2)` não
vai "limpar ruído" nenhum neste banco — os valores já são limpos. O `ROUND`
explícito no `ALTER COLUMN` (seção 7) continua sendo a prática correta mesmo
assim (defesa em profundidade — não custa nada e protege contra o caso hipotético
de algum valor sujo que ainda não foi visto).

---

## 3. Casos de precisão JS no código — classificado por severidade

### P0 — cálculo financeiro central (deve migrar pra Decimal)

| Arquivo | Função | O que faz |
|---|---|---|
| `lib/accounts.js` | `computeAccountBalance` | `base + income − expense + transfersIn − transfersOut` — saldo de conta, a fonte mais central de todas |
| `lib/cards.js` | `computeCardTotalLimit`/`computeCardUsedLimit`/`computeCardAvailableLimit` | `base + expense + purchase − payments`, `Math.max(0, used)`, `total − used` — limite de cartão |
| `lib/cardBillCalculator.js` | `computeExpectedCardBillTotal` | `expenseSum + installmentSum` — total de fatura |
| `lib/cardBillCalculator.js` | `payBill` | `remaining = Math.round((total−paid)*100)/100`, `newPaidAmount = Math.round((paid+amount)*100)/100` |
| `lib/cashFlowProjection.js` | `buildCashFlowProjection` | `running += event.amount` ao longo da timeline — projeção de caixa |
| `lib/unrestrictedCash.js` | `computeUnrestrictedCash` | `sum + a.balance` — fonte central de "dinheiro livre" |
| `lib/installments.js` | `generateInstallmentSchedule` | `Math.round((total − installmentValue*(count−1))*100)/100` — ajusta a última parcela pra bater com o total exato |
| `lib/commitBotIntent.js` | `commitInstallmentPurchase` | `installmentValue = Math.round((amount/count)*100)/100` — mesma classe, na criação |
| `lib/vaPanel.js` | `buildVaSnapshot` | `recebido`/`gasto` (aggregate), `balance` — saldo de VA |
| **`app/api/dashboard/route.js`** | `GET` (linhas 60-61) | **Achado desta auditoria**: `caixaAtual`/`saldoTotal` são recalculados **de novo, direto na rota**, com o mesmo filtro checking/cash que `lib/unrestrictedCash.js` já centraliza — é uma 4ª reimplementação da mesma soma que passou batida na centralização da Fase 1.1. Não é bug de valor errado hoje (o resultado é idêntico), mas é exatamente a classe de risco que motivou criar `unrestrictedCash.js` em primeiro lugar. **Recomendo trocar essas 2 linhas por `computeUnrestrictedCash(accounts)`/soma total via `lib/money.js` na Fase 3.1**, junto com a conversão pra Decimal. |

### P1 — cálculo financeiro importante (agregações/derivações sobre os P0, não a fonte primária)

| Arquivo | Função | O que faz |
|---|---|---|
| `lib/intelligence.js` | `buildFinancialSummary` | `restanteFatura = Math.max(0, total−paid−antecipado)`, `coversObligations` (`salaryAmount >= obligations`), `monthExpenseTotal` (reduce), `percentSalarySpent` |
| `lib/indicators.js` | `buildIndicators` | `patrimonioDisponivel` (reduce), `totalContasFuturas`/`totalFaturas`/`totalParcelas` (aggregate), `percentualSalarioComprometido`, `despesasFixas`/`despesasVariaveis`, `comprometimentoProximosMeses` |
| `lib/alerts.js` | `buildSpendingAboveAverageAlert` | `avgMonthTotal = reduce(...)/length`, `expectedByNow`, comparação `*1.2` |
| `lib/goals.js` | `estimateGoalForecast` | `remaining = Math.max(0, target−saved)`, `ratePerMonth = saved/months`, `monthsRemaining = remaining/rate` |
| `lib/upcomingObligations.js` | `listUpcomingObligations` | `remaining = Math.max(0, total−paid)`, `amount: -bill.amount` |
| `lib/amountExtractor.js` | `extractAmount` | `parseFloat(normalized)` — **ponto de entrada** do valor monetário vindo de texto livre (bot). Não é um cálculo que acumula erro, mas é onde um valor textual vira `Number` pela primeira vez — vale trocar `parseFloat` por passar a string direto pra `money()` na Fase 3.1 (decimal.js aceita string e não passa por `Number` no meio), evitando qualquer perda de precisão logo na entrada. |

### P2 — apresentação/serialização, pode continuar Number

| Arquivo | Local | O que faz |
|---|---|---|
| `lib/formatMoney.js` | `formatMoney` | `toLocaleString` — só exibição |
| `lib/parseTransaction.js` | mensagens de confirmação do bot | `.toFixed(2)` em texto pro usuário |
| `app/components/dashboard/TransactionsTable.jsx` | export CSV | `.toFixed(2)` na hora de gerar o arquivo |
| `app/components/dashboard/TopExpenses.jsx` | `.sort((a,b) => b.amount − a.amount)` | ordenação por valor — resultado nunca é armazenado, só decide ordem de exibição |
| `app/components/dashboard/CategoryBreakdown.jsx` | `pct = Math.round((value/total)*100)` | percentual de barra visual |
| `app/metas/MetasView.jsx` | `pct = Math.min(100, Math.round((saved/target)*100))` | percentual de barra visual |
| `lib/amountExtractor.js` | `reduce((a,b) => a.value > b.value ? a : b)` | escolhe o maior valor entre candidatos extraídos do texto (desambiguação) — comparação, não soma cumulativa |

### P3 — não monetário / falso positivo

| Arquivo | Local | Por que não é dinheiro |
|---|---|---|
| `lib/recurringCycles.js` | `Math.round(ms/(1000*60*60*24))` | conta dias, não Reais |
| `lib/alerts.js` | `Math.ceil((bill.dueAt−now)/(24*60*60*1000))` | dias até vencer |
| `lib/goals.js` | `monthsSinceCreated` (divisão por `1000*60*60*24*30`) | conta meses, não dinheiro (mesmo estando na mesma função que P1 acima) |

---

## 4. Mapa de impacto Float → Decimal

| Área | Impacto |
|---|---|
| **Prisma queries / `_sum` / `aggregate`** | `_sum.amount` passa a vir como `Prisma.Decimal`, não `number`. Todo `_sum.amount \|\| 0` (padrão usado em ~8 arquivos de `lib/`) precisa virar `toNumber(_sum.amount)` ou, na regra Decimal-first (Fase 2B), continuar em Decimal até a borda. |
| **`create`/`update`** | Prisma aceita `Decimal`, `number` ou `string` como input pra campo `Decimal` — não quebra nada que já escreve `amount: someNumber`, mas o valor grava exato (sem passar por `Float` binário) só se o valor de origem também já era exato (ver ponto do `parseFloat` acima). |
| **Account balances / Card limits / CardBill totals** | Já listados como P0 acima — são o núcleo do refactor. |
| **Purchase/Installment** | `installmentValue`/`amount` — cálculo de parcela (arredondamento da última parcela) precisa continuar em Decimal até o `roundMoney` final, não só na leitura. |
| **Bills / RecurringRule** | Mesma classe, hoje sem dado real no branch (0 linhas) — schema muda igual, sem risco de dado a migrar. |
| **Transfers** | Mesma classe, hoje sem dado real no branch (0 linhas). |
| **Projections (`cashFlowProjection.js`)** | `running` precisa ser `Decimal` do início ao fim do loop, não só a soma final — é exatamente o tipo de acumulação que mais se beneficia de nunca passar por `Number` no meio do caminho. |
| **Telegram parser/commit** | `amountExtractor.js` (P1 acima) é o ponto de entrada — recomendação de trocar `parseFloat` por string direto pro `money()`. `commitBotIntent.js` grava os valores já parseados — sem mudança estrutural, só o tipo que trafega internamente. |
| **API responses (`route.js`)** | **Regra dura**: nenhuma rota pode devolver um `Prisma.Decimal` cru no JSON — `Decimal.toJSON()` retorna **string**, não number, silenciosamente. Toda rota precisa passar cada campo monetário por `serializeMoney()` antes de `NextResponse.json(...)`. Esse é o maior risco de regressão silenciosa da migration inteira — vira teste obrigatório (seção 8). |
| **Frontend** | Zero mudança, **se** a regra acima for respeitada — o frontend inteiro já espera `number` puro, exatamente o que sai de `serializeMoney()`. |
| **Scripts** (`audit.js`, `audit-money-precision.js`, `migrate-legacy-transactions.js`) | Mesma mecânica de conversão na leitura; nenhum desses 3 escreve valor monetário calculado (audit.js e audit-money-precision.js são leitura pura; migrate-legacy-transactions.js só copia valores já existentes, não calcula nada novo). |
| **Seeds/migrations** | Não existe seed neste projeto. A migration em si (seção 7) é o único ponto de risco de dado. |

---

## 5. Proposta de `lib/money.js` (API definitiva — não implementada ainda)

```js
import { Prisma } from "@prisma/client";
const D = Prisma.Decimal;

// --- Tipo interno: Prisma.Decimal (= decimal.js) em TODA a vida útil do valor
// dentro de um cálculo financeiro. Number só existe ANTES de money() (entrada)
// e DEPOIS de serializeMoney() (saída/exibição). Nunca no meio.

// Normaliza number, string, Decimal ou null/undefined pra Decimal.
// - null/undefined -> Decimal(0) (money(null) nunca deveria explodir um cálculo
//   que soma valores opcionais — o chamador decide se null "deveria" ter sido
//   erro antes de chegar aqui).
// - string -> parseada DIRETO pelo decimal.js, sem passar por Number no meio
//   (evita qualquer perda de precisão binária na entrada).
// - number -> aceito, mas é a entrada MENOS confiável (já passou por precisão
//   binária antes de chegar aqui) — preferir sempre string quando a origem for
//   texto (ex: Telegram).
// - Decimal -> devolvido como está.
export function money(value) {
  if (value == null) return new D(0);
  if (value instanceof D) return value;
  return new D(value);
}

export function addMoney(a, b) { return money(a).plus(money(b)); }
export function subtractMoney(a, b) { return money(a).minus(money(b)); }
// factor: number puro (percentual, contagem de parcelas) — NÃO precisa ser Money.
export function multiplyMoney(a, factor) { return money(a).times(factor); }
// divisor: number puro. NÃO arredonda sozinho — decimal.js por padrão devolve
// até 20 dígitos significativos numa divisão. Quem chama decide quando (e se)
// arredondar via roundMoney(), explicitamente, no momento certo (ex: só depois
// de calcular a ÚLTIMA parcela pela subtração, não a cada parcela individual).
export function divideMoney(a, divisor) { return money(a).dividedBy(divisor); }

export function sumMoney(values) { return values.reduce((acc, v) => acc.plus(money(v)), new D(0)); }

// -1 | 0 | 1 — usar em vez de `a > b`/`a === b`, que não funcionam certo em
// objetos Decimal (comparação de referência/coerção incorreta).
export function compareMoney(a, b) { return money(a).comparedTo(money(b)); }
export function isPositive(v) { return money(v).greaterThan(0); }
export function isNegative(v) { return money(v).lessThan(0); }
export function isZeroMoney(v) { return money(v).isZero(); }
export function maxMoney(a, b) { return compareMoney(a, b) >= 0 ? money(a) : money(b); }
export function minMoney(a, b) { return compareMoney(a, b) <= 0 ? money(a) : money(b); }

// Arredondamento EXPLÍCITO — half-up, 2 casas, política oficial deste projeto
// pra Real. NENHUMA outra função deste arquivo arredonda por conta própria —
// arredondar é sempre uma decisão deliberada de quem chama, no momento certo
// (normalmente só uma vez, no fim de um cálculo, nunca a cada passo
// intermediário — arredondar cedo demais é exatamente o tipo de erro
// acumulado que Decimal existe pra evitar).
export function roundMoney(value, decimals = 2) {
  return money(value).toDecimalPlaces(decimals, Prisma.Decimal.ROUND_HALF_UP);
}

// ÚNICO ponto de conversão Decimal -> number. Só é chamado na BORDA — dentro de
// uma rota de API, montando a resposta JSON, ou formatando pra exibição. NUNCA
// dentro de uma função de lib/ que ainda vai fazer mais conta com o resultado.
export function serializeMoney(value) {
  return roundMoney(value).toNumber();
}

// Conveniência: serializa vários campos monetários de um objeto de uma vez, na
// borda da API — reduz o risco de esquecer um campo (o maior risco da migration,
// ver seção 4).
export function serializeMoneyFields(obj, fields) {
  const out = { ...obj };
  for (const f of fields) if (out[f] != null) out[f] = serializeMoney(out[f]);
  return out;
}

export const ZERO = new D(0);
```

**Política de arredondamento**: half-up, 2 casas, só em `roundMoney()`/
`serializeMoney()` — nunca implícito em `addMoney`/`subtractMoney`/`multiplyMoney`/
`divideMoney`. **Quando arredondar**: só no fim de uma cadeia de cálculo, antes de
gravar no banco ou de servir na API — nunca entre passos intermediários (é
precisamente o padrão que já existe em `installments.js`/`commitBotIntent.js`
hoje, só que em `Number` — a Fase 3.1 troca o tipo, não o padrão, que já está
certo). **null**: vira `Decimal(0)` em `money()` — decisão deliberada pra não
quebrar somas de campos opcionais (`paidAmount`, `newTotalLimit` etc.), mas isso
significa que `money(null)` e `money(0)` são indistinguíveis — se algum cálculo
específico precisar diferenciar "não informado" de "zero", ele checa `== null`
**antes** de chamar `money()`, não depois. **string**: parseada direto, é a
entrada preferida quando a origem é texto. **number de entrada**: aceito, mas
documentado como menos confiável (já passou por ponto flutuante binário antes).
**JSON**: nunca serializa um `Decimal` cru — sempre via `serializeMoney`/
`serializeMoneyFields`, na rota de API.

---

## 6. Validação do tamanho — Decimal(12,2)

**Não aceito automaticamente — verificado com o dado real.**

`NUMERIC(12,2)` no Postgres: precisão (`12`) é o total de dígitos significativos;
escala (`2`) é quantos ficam depois da vírgula. Isso deixa **10 dígitos antes da
vírgula** → valor máximo suportado: **R$ 9.999.999.999,99** (quase R$10 bilhões).

Maior valor real observado no branch `dev` hoje: **R$ 4.937,18** (`Income.amount`).
Isso é **~0,00005%** do teto de `NUMERIC(12,2)` — margem de mais de 2 milhões de
vezes o maior valor já visto no sistema.

Não existe cenário plausível pra este app (finanças pessoais de um usuário) que
chegue nem perto de R$10 bilhões — nem somando patrimônio, nem em projeção
acumulada de anos. `NUMERIC(14,2)` (R$ 999.999.999.999,99, ~100x maior teto)
seria puro excesso de provisão sem benefício real, e o custo de armazenamento
adicional de 2 dígitos de precisão no Postgres é irrelevante nessa escala.

**Decisão: mantenho `Decimal(12,2)`** — já é generoso o suficiente, validado
contra o dado real, não é uma escolha às cegas.

---

## 7. Migration plan (ordem segura — nada disso roda ainda)

**A) Relatório pré-migration** — feito nesta rodada (seção 2), 100% limpo.

**B) Alteração do schema** — todo campo `Float` da tabela da seção 1 vira
`Decimal @db.Decimal(12, 2)`. Aditivo em espírito (não remove/renomeia coluna),
mas é uma mudança de TIPO, não uma coluna nova — por isso precisa do `USING`
explícito no SQL (próximo item), diferente das migrations aditivas das fases
anteriores.

**C) SQL que seria gerado/proposto** (um `ALTER` por coluna — o `prisma migrate
dev` gera isso automaticamente ao detectar a mudança de tipo, mas o `USING` com
`ROUND` explícito normalmente precisa ser adicionado à mão no arquivo de
migration gerado, porque o Prisma sozinho não sabe que queremos arredondar):

```sql
ALTER TABLE "Card"              ALTER COLUMN "totalLimit"         TYPE NUMERIC(12,2) USING ROUND("totalLimit"::numeric, 2);
ALTER TABLE "Income"            ALTER COLUMN "amount"             TYPE NUMERIC(12,2) USING ROUND("amount"::numeric, 2);
ALTER TABLE "Expense"           ALTER COLUMN "amount"             TYPE NUMERIC(12,2) USING ROUND("amount"::numeric, 2);
ALTER TABLE "Transfer"          ALTER COLUMN "amount"             TYPE NUMERIC(12,2) USING ROUND("amount"::numeric, 2);
ALTER TABLE "BalanceAdjustment" ALTER COLUMN "newBalance"         TYPE NUMERIC(12,2) USING ROUND("newBalance"::numeric, 2);
ALTER TABLE "CardLimitUpdate"   ALTER COLUMN "newTotalLimit"      TYPE NUMERIC(12,2) USING ROUND("newTotalLimit"::numeric, 2);
ALTER TABLE "CardLimitUpdate"   ALTER COLUMN "newUsedLimit"       TYPE NUMERIC(12,2) USING ROUND("newUsedLimit"::numeric, 2);
ALTER TABLE "CardLimitUpdate"   ALTER COLUMN "reportedAvailable"  TYPE NUMERIC(12,2) USING ROUND("reportedAvailable"::numeric, 2);
ALTER TABLE "Purchase"          ALTER COLUMN "totalAmount"        TYPE NUMERIC(12,2) USING ROUND("totalAmount"::numeric, 2);
ALTER TABLE "Purchase"          ALTER COLUMN "installmentValue"   TYPE NUMERIC(12,2) USING ROUND("installmentValue"::numeric, 2);
ALTER TABLE "Installment"       ALTER COLUMN "amount"             TYPE NUMERIC(12,2) USING ROUND("amount"::numeric, 2);
ALTER TABLE "CardBill"          ALTER COLUMN "totalAmount"        TYPE NUMERIC(12,2) USING ROUND("totalAmount"::numeric, 2);
ALTER TABLE "CardBill"          ALTER COLUMN "paidAmount"         TYPE NUMERIC(12,2) USING ROUND("paidAmount"::numeric, 2);
ALTER TABLE "RecurringRule"     ALTER COLUMN "amount"             TYPE NUMERIC(12,2) USING ROUND("amount"::numeric, 2);
ALTER TABLE "Bill"              ALTER COLUMN "amount"             TYPE NUMERIC(12,2) USING ROUND("amount"::numeric, 2);
ALTER TABLE "Goal"              ALTER COLUMN "targetAmount"       TYPE NUMERIC(12,2) USING ROUND("targetAmount"::numeric, 2);
ALTER TABLE "Goal"              ALTER COLUMN "savedAmount"        TYPE NUMERIC(12,2) USING ROUND("savedAmount"::numeric, 2);
```
(NULL passa por `ROUND(NULL::numeric, 2)` = `NULL` naturalmente — sem tratamento
especial necessário pras colunas nullable.)

**D) Adaptação do código** — nesta ordem, pra nunca deixar o app quebrado no meio:
1. Criar `lib/money.js` (seção 5) — não usado por ninguém ainda, não quebra nada.
2. Trocar `parseFloat` por string em `lib/amountExtractor.js`.
3. Reescrever os arquivos P0 (seção 3) pra Decimal-first, um de cada vez, com
   `npm run build` + `node scripts/audit.js` depois de cada arquivo.
4. Reescrever os P1.
5. Confirmar que toda rota de API usa `serializeMoney`/`serializeMoneyFields`
   antes de `NextResponse.json` — checagem manual arquivo por arquivo de
   `app/api/**/route.js`, já que é o ponto de maior risco silencioso (seção 4).
6. Corrigir o achado do item 3 (`app/api/dashboard/route.js` reimplementando
   `unrestrictedCash`) nesse mesmo passo, já que está mexendo ali mesmo.

**E) Testes** — seção 8, todos antes de aprovar `migrate deploy` em produção.

**F) Comparação antes/depois** — rodar o MESMO conjunto de chamadas de API
(dashboard, cartões, indicadores) contra o branch `dev` antes do `B`/`C`
(schema ainda `Float`) e depois do `D` completo (schema `Decimal` + código
adaptado), e comparar as respostas JSON byte a byte — deve ser idêntico, porque
o relatório da seção 2 já provou que não há valor pra "corrigir".

---

## 8. Testes obrigatórios (Fase 3.1)

**Unitários puros (sem banco) pra `lib/money.js`:**
- `0.1 + 0.2` → em `Number` dá `0.30000000000000004`; `addMoney(money("0.1"), money("0.2")).toString()` deve dar exatamente `"0.3"`.
- `61.61 + 114.63` → deve dar exatamente `176.24`.
- `8730.47 − 7000` → deve dar exatamente `1730.47`.
- `170.68 * 3` → deve dar exatamente `512.04`.
- `2465 * 0.10` → deve dar exatamente `246.5`.
- Comparações exatas de centavos: `compareMoney(money("60.60"), money("60.6"))` → `0`.
- Soma de dezenas/centenas de `Expense` fabricados em memória (array de 106 valores tipo os do branch `dev`) → soma exata, comparada contra a soma que o Postgres `_sum` real devolve pro mesmo conjunto.
- Soma de parcelas de uma `CardBill` (replicar o cálculo de `computeExpectedCardBillTotal`) com valores fabricados que dariam erro perceptível em `Float` (ex: 3 parcelas de `170.68` cuja soma deveria ser `512.04`, não `512.03999999999996`).
- `roundMoney` em valor de meio-centavo (`0.005`) — documentar o comportamento exato do `ROUND_HALF_UP` escolhido.

**Regressão arquitetural:**
- Saldo de `Account`, limite de `Card`, projeção de `cashFlowProjection`, e o
  futuro `freeMoney` — cada um calculado com o snapshot real do branch `dev`,
  **antes** da migration (schema `Float`, código atual) e **depois** (schema
  `Decimal`, código adaptado) — devem ser byte-a-byte idênticos no JSON final,
  já que a seção 2 provou que não há "correção" de valor a fazer, só troca de
  tipo interno.
- **Todo campo monetário em toda resposta de API é `typeof === "number"`** —
  teste automatizado que varre as respostas de `/api/dashboard`, `/api/cards`,
  `/api/indicators` etc. e falha se encontrar uma `string` onde deveria ter
  `number` (pega exatamente o footgun do `Decimal.toJSON()` retornar string,
  seção 4 — esse é o teste mais importante de todos, porque é o único risco
  real de regressão silenciosa nessa migration).

**Integração no branch `dev`** (com `assertTestEnvironment()`, escreve e limpa —
só depois que tivermos decidido rodar escrita de teste, não faz parte desta
fase 3.0 diagnóstica):
- Criar uma `CardBill` de teste com parcelas que somem um valor historicamente
  problemático em Float (ex: `0.1 + 0.2` embutido em algum lugar da conta),
  confirmar que bate exato.

---

## 9. `scripts/audit-money-precision.js` — segue a regra de `scripts/audit.js`

Confirmado por grep: zero `.create`/`.update`/`.delete`/`.upsert`/`updateMany`/
`deleteMany`/`createMany`/`$executeRaw`/`$queryRaw` no arquivo inteiro — só
`findMany`/`count`. Documentado no cabeçalho do próprio script, mesmo padrão do
banner já existente em `scripts/audit.js`. Não usa `assertTestEnvironment()`
pelo mesmo motivo que `audit.js` não usa: é seguro por design pra rodar até
contra produção.

---

## 10. Arquivos que a Fase 3.1 deverá alterar (lista, nenhum tocado ainda)

**Schema**: `prisma/schema.prisma` (17 campos `Float` → `Decimal @db.Decimal(12,2)`).

**Novo**: `lib/money.js` (seção 5).

**P0 (núcleo, Decimal-first)**: `lib/accounts.js`, `lib/cards.js`,
`lib/cardBillCalculator.js`, `lib/cashFlowProjection.js`, `lib/unrestrictedCash.js`,
`lib/installments.js`, `lib/commitBotIntent.js` (trecho de parcela),
`lib/vaPanel.js`, **`app/api/dashboard/route.js`** (achado desta auditoria —
parar de reimplementar `unrestrictedCash`).

**P1 (agregações)**: `lib/intelligence.js`, `lib/indicators.js`, `lib/alerts.js`,
`lib/goals.js`, `lib/upcomingObligations.js`, `lib/amountExtractor.js` (trocar
`parseFloat` por string).

**Todas as rotas de API** (`app/api/**/route.js`) — revisão pra garantir
`serializeMoney`/`serializeMoneyFields` antes de todo `NextResponse.json`.

**P2 (sem mudança estrutural, só confirmar que continuam recebendo `number`
puro)**: `lib/formatMoney.js`, `lib/parseTransaction.js`,
`app/components/dashboard/TransactionsTable.jsx`,
`app/components/dashboard/TopExpenses.jsx`,
`app/components/dashboard/CategoryBreakdown.jsx`, `app/metas/MetasView.jsx` —
não precisam de código novo, só ficam sob teste de regressão (seção 8) pra
confirmar que continuam recebendo `number`.

**Scripts**: `scripts/audit.js` e `scripts/audit-money-precision.js` — ajuste
mecânico de leitura (`toNumber`/campos já vêm como `Decimal` do Prisma), sem
mudança de lógica.

---

## Resumo executivo

Banco **limpo** — nenhum dado precisa de correção na migration. Achado real de
código: `app/api/dashboard/route.js` reimplementa `unrestrictedCash` pela 4ª vez,
deve ser corrigido junto com a Fase 3.1. Maior risco identificado: `Decimal`
serializado sem passar por `serializeMoney` vira **string** silenciosamente no
JSON — vira o teste #1 da suíte. `Decimal(12,2)` validado contra dado real
(margem de >2 milhões de vezes o maior valor já visto). Nada foi alterado nesta
fase — só leitura, do início ao fim.
