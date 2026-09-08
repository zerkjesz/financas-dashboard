# Blueprint arquitetural — Schema V2 (Norte)

Status: **proposta, revisão 2, aguardando aprovação**. Nenhuma migration foi criada.
Nenhum model novo existe no schema. Nenhum dado foi alterado.

---

## 1. Dinheiro / precisão — Decimal do banco até o cálculo, Number só na borda

Direção aprovada: **Decimal/NUMERIC(12,2)**. Revisão importante desta rodada: **não
converter pra `Number` antes de calcular** — a conversão só acontece na borda,
depois que o resultado financeiro já está fechado.

```
Banco (NUMERIC) → leitura (Prisma.Decimal) → cálculo financeiro (Decimal) →
  → resultado fechado → serialização (Number) → JSON da API → frontend
```

`Prisma.Decimal` **é** `decimal.js` por baixo — não preciso adicionar nenhuma
dependência nova, é reexportado pelo `@prisma/client` que já está instalado.

### `lib/money.js` — camada central (revisado, além de conversão/arredondamento)

```js
import { Prisma } from "@prisma/client";
const D = Prisma.Decimal;

// Normaliza qualquer entrada (number, string, Decimal, null) pra Decimal.
export function money(value) {
  if (value == null) return new D(0);
  if (value instanceof D) return value;
  return new D(value);
}

export function addMoney(a, b) { return money(a).plus(money(b)); }
export function subtractMoney(a, b) { return money(a).minus(money(b)); }
export function multiplyMoney(a, factor) { return money(a).times(factor); } // factor: number puro (ex: %, contagem de parcelas)
export function sumMoney(values) { return values.reduce((acc, v) => acc.plus(money(v)), new D(0)); }

// -1 | 0 | 1 — usar em vez de `a > b`/`a === b`, que não funcionam certo em objetos Decimal.
export function compareMoney(a, b) { return money(a).comparedTo(money(b)); }
export function isPositive(v) { return money(v).greaterThan(0); }
export function isNegative(v) { return money(v).lessThan(0); }
export function maxMoney(a, b) { return compareMoney(a, b) >= 0 ? money(a) : money(b); }

// Arredondamento EXPLÍCITO — half-up, 2 casas, é a política oficial deste projeto
// pra Real. Nenhuma outra função deste arquivo arredonda por conta própria.
export function roundMoney(value, decimals = 2) {
  return money(value).toDecimalPlaces(decimals, Prisma.Decimal.ROUND_HALF_UP);
}

// ÚNICO ponto de conversão Decimal -> number. Só é chamado na borda — rota de API,
// antes de formatar pra exibição — NUNCA dentro de um cálculo financeiro.
export function serializeMoney(value) {
  return roundMoney(value).toNumber();
}

export const ZERO = new D(0);
```

### O que isso muda de verdade

Diferente da proposta anterior (que convertia pra `number` logo na leitura), agora
**toda função de cálculo financeiro em `lib/*.js` — `accounts.js`, `cards.js`,
`cardBillCalculator.js`, `intelligence.js`, `cashFlowProjection.js`, `indicators.js`,
`vaPanel.js`, `goals.js`, `unrestrictedCash.js`, e o futuro `freeMoney.js`/
`incurredLiabilities.js` — passa a somar/subtrair usando `addMoney`/`subtractMoney`
em vez de `+`/`-` nativo**, mantendo tudo em `Decimal` internamente, inclusive
quando uma função chama outra (ex: `intelligence.js` chamando
`cashFlowProjection.js`). Só a resposta final de uma rota de API (ou o ponto onde o
valor vai ser formatado com `formatMoney`) chama `serializeMoney()`.

Isso é um refactor mecânico, mas **real e maior** do que eu tinha estimado
inicialmente (que só tocava o ponto de leitura) — é esperado que essa parte seja
feita junto com a migration de schema, como uma fase própria, não um ajuste
pontual. Fica registrado aqui como a arquitetura correta; a execução entra no
"Migration plan" no fim deste documento.

### Relatório read-only antes da migration (nenhum arredondamento silencioso)

Antes de rodar `Float -> Decimal` em qualquer campo, um script novo (a ser criado
quando começarmos a Fase 3 de verdade — **ainda não criado, só desenhado aqui**)
gera um relatório, **sem escrever nada**:

```
scripts/report-decimal-migration.mjs (planejado)

Pra cada campo monetário afetado, pra cada linha:
  valor atual (Float, lido como está)
  valor ROUND(2) (o que a migration vai gravar)
  diferença (atual - arredondado)

Saída: só linhas onde diferença != 0 (ruído de float que a migration vai limpar).
Nada é escrito. Você revisa a lista antes de aprovar a migration.
```

Não rodei esse relatório ainda — é read-only e seguro, mas como você pediu que o
entregável desta rodada fique só em documentação, ele fica desenhado aqui, pronto
pra eu construir e rodar assim que você der sinal (é literalmente o primeiro passo
concreto da Fase 3, antes de qualquer `ALTER COLUMN`).

---

## 2. Reserve / dinheiro protegido — ledger com direção explícita e sem inversão dupla

`amount` **sempre positivo**. `kind` define a direção — sem ambiguidade nenhuma,
inclusive pro caso de correção:

```prisma
enum ReserveMovementKind {
  ALLOCATE            // +
  REPLENISH           // +
  RELEASE             // -
  ADJUSTMENT_INCREASE // +
  ADJUSTMENT_DECREASE // -
}

model Reserve {
  id           String   @id @default(cuid())
  accountId    String
  account      Account  @relation(fields: [accountId], references: [id])
  name         String
  targetAmount Decimal? @db.Decimal(12, 2)
  status       String   @default("active") // "active" | "completed" | "closed"
  notes        String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  movements ReserveMovement[]
}

model ReserveMovement {
  id         String              @id @default(cuid())
  reserveId  String
  reserve    Reserve             @relation(fields: [reserveId], references: [id])
  amount     Decimal             @db.Decimal(12, 2) // SEMPRE > 0 — CHECK constraint no banco
  kind       ReserveMovementKind
  note       String?
  occurredAt DateTime            @default(now())
}
```

**Por que virou enum de verdade (`ReserveMovementKind`), não `String` como o resto
do projeto usa hoje**: você pediu constraint/validação explícita contra combinação
contraditória. Um `String` livre permitiria `kind: "banana"` ou um `"adjustment"`
genérico cuja direção só existe na cabeça de quem escreveu o código que o
interpreta — exatamente o risco de "inversão dupla" que você apontou (`release`
com `amount` negativo geraria `-(-x) = +x`, invertendo o sentido sem ninguém
perceber). Separar `adjustment` em `ADJUSTMENT_INCREASE`/`ADJUSTMENT_DECREASE`
elimina essa ambiguidade — cada valor do enum tem UM sinal, ponto.

### Constraints

- **Nível banco** (SQL bruto na migration, Prisma não tem `@check` estável na
  versão em uso): `CHECK (amount > 0)` em `ReserveMovement.amount`.
- **Nível aplicação** (quando `lib/reserves.js` existir): valida `amount > 0` antes
  de qualquer `create` (defesa em profundidade, não confia só no banco), e usa uma
  tabela de sinal fixa, não interpretação livre:
  ```js
  const SIGN = { ALLOCATE: 1, REPLENISH: 1, RELEASE: -1, ADJUSTMENT_INCREASE: 1, ADJUSTMENT_DECREASE: -1 };
  const signedAmount = multiplyMoney(movement.amount, SIGN[movement.kind]);
  ```

`protectedMoney(reserveId)` = soma de `amount * SIGN[kind]` sobre os movimentos —
nunca um campo mutável.

---

## 3. Saldo credor de cartão — ledger não apaga nem reduz o gasto original

`CardCreditMovement` (aprovado como ledger). Formalizando o ponto que você pediu:

**Regra dura: saldo credor afeta só o *settlement* (quanto dinheiro precisa sair da
conta pra fechar a fatura). Nunca apaga, reduz ou "some" com o `Expense`/`Purchase`
original — a compra aconteceu, ela continua contando em gastos por categoria e em
qualquer análise de gasto, sempre.**

```prisma
enum CardCreditMovementKind {
  OVERPAYMENT  // +  gerado por pagamento acima do restante da fatura
  CONSUMPTION  // -  aplicado pra abater o valor devido de uma fatura nova
  ADJUSTMENT   // direção livre, mas sempre com note obrigatório (auditoria manual)
}

model CardCreditMovement {
  id         String                 @id @default(cuid())
  cardId     String
  card       Card                   @relation(fields: [cardId], references: [id])
  amount     Decimal                @db.Decimal(12, 2)
  kind       CardCreditMovementKind
  cardBillId String?                // fatura que gerou/consumiu o crédito — rastreabilidade
  cardBill   CardBill?              @relation(fields: [cardBillId], references: [id], onDelete: SetNull)
  note       String?
  occurredAt DateTime               @default(now())
}
```

### Exemplo (o seu, passo a passo)

```
Crédito do cartão antes:                     R$ 209,11

Compra "alimentação" acontece normalmente:
  Expense.amount = R$ 35,00                  (criada exatamente como qualquer gasto — nada muda aqui)
  -> entra em "gastos por categoria" como R$ 35,00, sempre.

Quando a fatura daquele ciclo é fechada/liquidada:
  creditBalance(cardId) = 209,11 > 0 -> aplica até cobrir o total da fatura
  CardCreditMovement(kind: CONSUMPTION, amount: 35,00, cardBillId: <essa fatura>)
  novo saldo credor = 209,11 - 35,00 = R$ 174,11

CardBill.totalAmount continua R$ 35,00 (reflete a compra real do ciclo, sem mudar).
"Valor adicional devido em dinheiro" por essa fatura = totalAmount - paidAmount - créditoAplicado
                                                      = 35,00 - 0 - 35,00 = R$ 0,00
```

`remaining` (o que `payBill` usa pra saber quanto ainda falta) passa a ser:
```
remaining = totalAmount − paidAmount − appliedCredit(cardBillId)
```
onde `appliedCredit(cardBillId)` = soma dos `CONSUMPTION` daquela fatura específica.
A lógica exata de **quando** aplicar crédito automaticamente (no fechamento da
fatura? só quando o usuário pede pra pagar?) fica pra fase de implementação do
ciclo do cartão — aqui só está fixado que gasto por categoria nunca perde a compra.

---

## 4. Contingency

Mantido: **não reduz `freeMoney`** por padrão. Alimenta `expected scenario`
(`expectedAmount`, informativo) e `worst-case/stress scenario`
(`freeMoneyWorstCase = freeMoney − Σ Contingency.maxAmount` das ativas) — sempre
mostrado à parte, nunca misturado no número principal.

---

## 5. ConfirmedCommitment — lifecycle revisado, com Reserve integrada

**Os três estados são semanticamente distintos, sem sobreposição de significado:**
- **`CONFIRMED`** — o compromisso existe, valor e data conhecidos. Não diz nada
  sobre de onde vai sair o dinheiro nem se já foi pago.
- **`FUNDED`** — uma origem foi explicitamente escolhida (`fundingSourceType`).
  **Não cria `Expense`. Não significa que o pagamento aconteceu.** É só "já sei de
  onde vai sair", uma intenção registrada — o dinheiro continua exatamente onde
  estava (na conta, ou realocado de uma Reserve) até o passo seguinte.
- **`SETTLED`** — o único estado em que dinheiro de verdade se moveu. Só acontece
  quando o `Expense` real existe e está vinculado via `settledExpenseId`. Antes
  disso, `SETTLED` não é um estado alcançável.

```prisma
model ConfirmedCommitment {
  id                String    @id @default(cuid())
  description       String
  amount            Decimal   @db.Decimal(12, 2)
  dueDate           DateTime
  status            String    @default("confirmed") // "confirmed" | "funded" | "settled" | "cancelled"
  fundingSourceType String?   // "account" | "reserve" | null
  fundingAccountId  String?
  fundingAccount    Account?  @relation(fields: [fundingAccountId], references: [id], onDelete: SetNull)
  fundingReserveId  String?
  fundingReserve    Reserve?  @relation(fields: [fundingReserveId], references: [id], onDelete: SetNull)
  settledExpenseId  String?   @unique
  settledExpense    Expense?  @relation(fields: [settledExpenseId], references: [id], onDelete: SetNull)
  notes             String?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
}
```

### Lifecycle completo, com o exemplo que você deu (Itaú R$8.730, Reserva
Importação R$7.000, Tattoo R$2.465)

**Estado A — `confirmed`, sem funding.**
```
protectedMoney (Importação)  = 7.000,00
confirmedCommitments (Tattoo) = 2.465,00

freeMoney = unrestrictedCash − protectedMoney − confirmedCommitments
          = 8.730,00 − 7.000,00 − 2.465,00 = R$ −735,00
```
As duas coisas são subtraídas de forma independente — nesse momento elas ainda são
DUAS reivindicações separadas sobre o mesmo dinheiro (a reserva está guardada pra
outra coisa; o compromisso ainda não tem de onde vai sair). Isso não é dupla
contagem — é conservador corretamente, porque de fato nenhuma das duas coisas foi
resolvida ainda.

**Estado B — usuário define funding pela reserva.** Ação explícita, dois efeitos
juntos: `ConfirmedCommitment.status → "funded"`, `fundingSourceType: "reserve"`,
`fundingReserveId: <Importação>` **e** um `ReserveMovement(kind: RELEASE, amount:
2.465,00, reserveId: <Importação>)` é criado.

```
protectedMoney (Importação) = 7.000,00 − 2.465,00 = 4.535,00
confirmedCommitments (Tattoo, ainda não settled) = 2.465,00 (continua contando — só muda de "de onde vem")

freeMoney = 8.730,00 − 4.535,00 − 2.465,00 = R$ 1.730,00
```
O mesmo dinheiro não foi subtraído duas vezes: a reserva encolheu exatamente pelo
valor que passou a estar "reservado especificamente pro Tattoo dentro do que era
Importação", e o compromisso continua contando uma vez só. **`funded` nunca cria o
`ReserveMovement` sozinho por trás — é uma ação explícita do usuário, as duas coisas
acontecem juntas deliberadamente, nunca automaticamente por inferência.**

**Essa transição (`status → "funded"` + criar o `ReserveMovement`) é uma unidade
atômica — as duas escritas acontecem dentro de um `prisma.$transaction`, igual ao
padrão já estabelecido em `payBill` (Fase 1): ou as duas gravam, ou nenhuma grava.
Sem isso, uma falha no meio do caminho deixaria o commitment marcado "funded" sem
o `ReserveMovement` correspondente (ou vice-versa) — exatamente o tipo de
inconsistência que essa auditoria inteira existe pra evitar.**

**Estado C — pagamento acontece (settlement).** `Account` (Itaú) cai R$2.465 de
verdade via um `Expense` real; `Expense` é criado e vinculado
(`settledExpenseId`); `ConfirmedCommitment.status → "settled"`. **Também dentro de
um `prisma.$transaction`** — criar o `Expense` e marcar `settled` são a mesma
unidade atômica; se uma falhar, a outra não pode ter acontecido sozinha (senão
teríamos um `Expense` real sem o commitment fechado, contando os R$2.465 duas
vezes até alguém notar, ou um commitment `settled` sem `Expense` real, escondendo
que o dinheiro nunca saiu de fato).

```
unrestrictedCash (Itaú já debitado) = 8.730,00 − 2.465,00 = 6.265,00
protectedMoney (Importação)         = 4.535,00 (não muda no settlement — só mudou no funding)
confirmedCommitments                 = 0,00 (settled é EXCLUÍDO da soma)

freeMoney = 6.265,00 − 4.535,00 − 0,00 = R$ 1.730,00
```
**O número não muda entre o Estado B e o Estado C** — R$1.730,00 nos dois. Essa é a
prova de que não houve dupla contagem em nenhum momento: o settlement só converte
"passivo confirmado" em "caixa já reduzido de verdade", nunca soma as duas coisas.
Essa invariante (freeMoney não pula no momento do settlement de um commitment já
funded) vira um teste automatizado (seção de testes, no fim).

### Replenishment (repor a reserva depois)

Não é campo novo — é **computado**: `replenishmentGap = max(0, targetAmount −
protectedMoney atual)`. No exemplo: `Importação.targetAmount = 7.000`,
`protectedMoney = 4.535` → `replenishmentGap = 2.465`. Quando o usuário guardar mais
pra Importação depois: `ReserveMovement(kind: REPLENISH, amount: X)`, e o gap
encolhe naturalmente.

Se o funding for `fundingSourceType: "account"` (sem reserva envolvida), não existe
`ReserveMovement` nenhum — o `ConfirmedCommitment` só continua sendo subtraído
normalmente do `freeMoney` até `settled`, sem interação com nenhuma reserva.

---

## 6. Budget histórico — modelagem por ciclo, sem overlap possível

Adoto sua sugestão — mais simples que períodos genéricos, e evita overengineering
de constraint de intervalo (que exigiria `EXCLUDE USING gist` no Postgres pra
impedir sobreposição de ranges — desnecessário aqui):

```prisma
model CategoryBudget {
  id         String   @id @default(cuid())
  category   String
  cycleStart DateTime // hoje: dia 1 do mês calendário (mesma convenção de Bill.cycleMonth).
                       // Quando lib/cycle.js (ciclo 24->23) existir, passa a ser o dia 24.
  amount     Decimal  @db.Decimal(12, 2)
  notes      String?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@unique([category, cycleStart])
}
```

`cycleEnd` **não é coluna** — é derivado por função (`cycleStart + 1 ciclo`, usando
a mesma lógica de `lib/cycle.js`/a convenção de mês calendário atual). Como cada
`cycleStart` identifica exatamente um ciclo discreto (não um intervalo arbitrário),
`@@unique([category, cycleStart])` já impede qualquer sobreposição por construção —
não existem dois `cycleStart` diferentes que se sobrepõem, porque os ciclos são uma
sequência fixa, não datas livres.

Isso também resolve "preservar contexto histórico" sem precisar de um sistema de
period-range: cada ciclo já passado tem sua própria linha, imutável na prática
(nada mais escreve nela depois que o ciclo vira passado); planejar um ciclo futuro
diferente é só inserir uma linha nova com o `cycleStart` daquele ciclo. Corrigir um
erro num ciclo específico é editar exatamente aquela linha (é uma correção pontual,
não uma reescrita de histórico, porque outros ciclos não são tocados).

---

## 7. Incurred liability vs future scheduled obligation — classificador central e testável

Você está certo: a distinção não pode existir só como efeito colateral de como as
queries acontecem hoje. Formalizando como uma função pura, testável sem banco, mais
um agregador que a usa.

### `lib/obligationClassifier.js` (novo, puro — sem acesso a banco)

```js
// Cada classify* responde: "incurred" (reduz freeMoney agora) | "future" (só
// projeção) | "not_applicable" (pago/cancelado, não conta em lugar nenhum).
// Recebe o registro já buscado — não faz query. Isso é o que torna testável com
// dado fabricado em memória, sem precisar de banco pra cada caso de teste.

export function classifyCardBill(cardBill) {
  // TODA CardBill materializada com saldo devedor é incurred, sempre — a compra
  // que gerou o valor já aconteceu, independente do dueAt.
  if (!["open", "closed", "partially_paid"].includes(cardBill.status)) return "not_applicable";
  const remaining = subtractMoney(subtractMoney(cardBill.totalAmount, cardBill.paidAmount ?? 0), cardBill.appliedCredit ?? 0);
  return isPositive(remaining) ? "incurred" : "not_applicable";
}

export function classifyBill(bill) {
  return ["pending", "overdue"].includes(bill.status) ? "incurred" : "not_applicable";
}

export function classifyExternalInstallment(installment, { currentCycleKey }) {
  if (installment.status === "paid") return "not_applicable";
  // Só a parcela cujo ciclo já chegou é incurred — parcelas futuras do MESMO plano
  // já acordado continuam "future" até o próprio mês chegar.
  return installment.billMonth <= currentCycleKey ? "incurred" : "future";
}

// Regra final (decisão fechada): uma ConfirmedCommitment reduz freeMoney AGORA
// quando (B) vence até a próxima renda esperada, OU (C) já foi explicitamente
// fundada/earmarked (status "funded"), mesmo que o vencimento seja depois da
// próxima renda. Confirmada mas sem funding e vencendo depois da próxima renda =
// "future": não reduz freeMoney hoje, mas conta em projeção e em "comprometimento
// futuro / próxima renda" (ver seção 10).
export function classifyConfirmedCommitment(commitment, { nextIncomeDate }) {
  if (["settled", "cancelled"].includes(commitment.status)) return "not_applicable";
  if (commitment.dueDate <= nextIncomeDate) return "incurred"; // regra B
  if (commitment.status === "funded") return "incurred"; // regra C — já tem origem definida agora
  return "future";
}

export function classifyContingency() {
  return "future"; // nunca incurred — pode nem acontecer
}
```

### `lib/incurredLiabilities.js` (agregador, com banco)

```js
export async function computeIncurredLiabilities() {
  const [cardBills, bills] = await Promise.all([
    prisma.cardBill.findMany({ where: { status: { in: ["open", "closed", "partially_paid"] } } }),
    prisma.bill.findMany({ where: { status: { in: ["pending", "overdue"] } } }),
  ]);
  let total = ZERO;
  for (const cb of cardBills) if (classifyCardBill(cb) === "incurred") total = addMoney(total, remainingOf(cb));
  for (const b of bills) if (classifyBill(b) === "incurred") total = addMoney(total, money(b.amount));
  // ExternalInstallment entra aqui do mesmo jeito quando o model existir.
  return total; // Decimal — quem chama decide quando serializar
}
```

`ConfirmedCommitment` é somado **separadamente**, como `confirmedCommitments`
(seção 8) — usa o mesmo classificador (`classifyConfirmedCommitment`), mas
continua sendo uma camada própria na fórmula de `freeMoney`, não misturada em
`incurredLiabilities` (mantém a distinção conceitual: uma é sobre transações que já
aconteceram, a outra é sobre promessas confirmadas ainda não realizadas).

**Regra A** (`classifyCardBill`/`classifyBill`: incurred sempre, independente de
data) já está formalizada nessas duas funções desde a primeira versão deste
documento — nenhuma mudança nesta rodada, só confirmando que ela é exatamente a
mesma régua que as regras B/C de `ConfirmedCommitment` complementam, não substituem.

O ganho real disto: `classifyCardBill({status: "closed", totalAmount: ..., ...})`
vira um teste unitário puro, sem precisar tocar banco nenhum pra validar a regra —
exatamente o "central/testável" que você pediu. Casos de teste obrigatórios pra
`classifyConfirmedCommitment` (unitários, puros, sem banco):
- `dueDate` antes da próxima renda, `status: "confirmed"`, sem funding → `"incurred"` (regra B).
- `dueDate` depois da próxima renda, `status: "funded"` → `"incurred"` (regra C).
- `dueDate` depois da próxima renda, `status: "confirmed"`, sem funding → `"future"`.
- `status: "settled"` ou `"cancelled"`, qualquer data → `"not_applicable"`.

---

## 8. Data confidence — enum ampliado

```prisma
enum DataConfidence {
  CONFIRMED
  CONFIRMED_BY_MEMORY
  ESTIMATED
  UNCERTAIN
  RECONCILIATION_ADJUSTMENT
}
```

### Em quais models (lista ampliada)

`confidence DataConfidence @default(CONFIRMED)` em: **`Income`**, **`Expense`**,
**`Transfer`**, **`BalanceAdjustment`**, **`CardLimitUpdate`**, **`Purchase`**,
**`Bill`**, **`ExternalInstallmentPlan`**, **`ConfirmedCommitment`**,
**`Contingency`**, **`Receivable`**, **`ReserveMovement`**.

**`ExternalInstallment`** (a parcela individual, filha de `ExternalInstallmentPlan`)
**não** ganha campo próprio — quando gerada deterministicamente a partir do plano
(mesma lógica de `generateInstallmentSchedule`), ela herda semanticamente a
confiança do plano-pai, evitando redundância de 12 linhas repetindo o mesmo valor
do plano. Se um dia uma parcela específica precisar de confiança diferente da do
plano (ex: uma parcela foi renegociada e a data real é incerta), isso é uma
extensão pontual pra decidir na hora, não uma coluna especulativa agora.

**Sem `confidence`**: `CardBill` (sempre derivada ao vivo de `Expense`/
`Installment` — confiança mora nas linhas de origem), `Reserve`/`CardCreditMovement`/
`CategoryBudget`/`AppSettings` (construções pra frente, não reconstrução de
passado).

`source` (proveniência) e `confidence` (confiança no valor) continuam eixos
independentes, como já estabelecido.

---

## 9. Histórico operacional

Sem mudança da rodada anterior — `AppSettings.operationalHistoryStart` (24/08/2026)
e `vaHistoryStart` (21/08/2026), aplicados como filtro de query em cálculos
operacionais novos, nunca como exclusão/apagamento de linha.

---

## 10. freeMoney — fórmula (atualizada com Reserve/ConfirmedCommitment integrados)

**Horizonte oficial**: `nextIncomeDate` = data da próxima entrada de renda esperada
(mesmo `nextOccurrence(salaryRule.dayOfMonth, now)` que `intelligence.js` já usa
hoje). É esse valor que alimenta `classifyConfirmedCommitment` (seção 7).

| Camada | Definição |
|---|---|
| `totalBalances` | `Σ Account.balance`, todas as contas |
| `unrestrictedCash` | `Σ Account.balance`, checking+cash — já existe (`lib/unrestrictedCash.js`) |
| `protectedMoney` | `Σ (ReserveMovement.amount × sinal[kind])`, Reserves `active` |
| `incurredLiabilities` | `computeIncurredLiabilities()` — seção 7, regra A (sempre, sem corte de data) |
| `confirmedCommitments` | `Σ amount`, `ConfirmedCommitment` onde `classifyConfirmedCommitment(c, {nextIncomeDate}) === "incurred"` — regras B (vence até `nextIncomeDate`) ou C (`status: "funded"`, mesmo vencendo depois) |
| **`freeMoney`** | `unrestrictedCash − protectedMoney − incurredLiabilities − confirmedCommitments` |
| **`safeToSpend`** | `max(0, freeMoney × (1 − safetyMarginPercent/100))`, `safetyMarginPercent` de `AppSettings` |
| `freeMoneyWorstCase` | `freeMoney − Σ Contingency.maxAmount` ativa — sempre separado, nunca reduz `freeMoney` |
| `comprometimentoFuturo` | `Σ amount` de `ConfirmedCommitment` classificados `"future"` (confirmados, sem funding, vencendo depois da próxima renda) — não reduz `freeMoney` hoje, mas é mostrado como "isso vai pesar depois que a renda entrar" |
| `projectedCash` | `cashFlowProjection.projectedBalance` — **inalterado**, continua partindo de `unrestrictedCash`, nunca de `freeMoney` |

Exemplo completo (retomando o Estado A do lifecycle da seção 5, com os outros
componentes do exemplo original também presentes; supondo que o `dueDate` do
Tattoo caia ANTES da próxima renda — regra B se aplica mesmo sem funding):

```
unrestrictedCash                                    R$ 8.730,47
protectedMoney (Importação)                         R$ 7.000,00
incurredLiabilities (fatura R$716,97 + luz R$200)   R$   916,97
confirmedCommitments (Tattoo, dueDate <= nextIncomeDate — regra B)  R$ 2.465,00

freeMoney = 8.730,47 − 7.000,00 − 916,97 − 2.465,00 = R$ −1.651,50
safeToSpend (margem 10%)                            = R$ 0,00
freeMoneyWorstCase (Tiger, max R$2.000)              = −1.651,50 − 2.000,00 = R$ −3.651,50
```

Toda a aritmética acima, na implementação real, roda em `Decimal` (`addMoney`/
`subtractMoney`/`maxMoney`) até o resultado final — só é convertida pra `number`
(`serializeMoney`) quando a rota de API monta a resposta.

### Contraste — regras B, C e "future" lado a lado

Mesmo Tattoo (R$2.465), três cenários diferentes de data/funding, mostrando a
régua completa:

```
Cenário 1 — dueDate ANTES da próxima renda, sem funding (regra B):
  classifyConfirmedCommitment = "incurred" -> entra em confirmedCommitments, reduz freeMoney agora.

Cenário 2 — dueDate DEPOIS da próxima renda, status "funded" (regra C):
  classifyConfirmedCommitment = "incurred" -> MESMO vencendo depois, já foi
  explicitamente fundado agora (ex: origem = Reserve Importação, com o
  ReserveMovement RELEASE já feito) -> reduz freeMoney agora. protectedMoney da
  Importação já encolheu pelo mesmo valor no momento do funding (seção 5) — sem
  dupla contagem.

Cenário 3 — dueDate DEPOIS da próxima renda, sem funding, só "confirmed":
  classifyConfirmedCommitment = "future" -> NÃO reduz freeMoney hoje. Entra em
  `comprometimentoFuturo` (R$2.465,00) e na timeline de cashFlowProjection como
  evento futuro -> aparece como "isso vai pesar quando a renda entrar", visível,
  mas não subtraído do dinheiro livre de agora.
```

---

## 11. Autenticação — plano completo (revisado: `crypto.scrypt` nativo, não `bcryptjs`)

Decisão fechada: `crypto.scrypt` do Node (`node:crypto`, nativo, zero dependência
nova) em vez de `bcryptjs`.

| Item | Decisão |
|---|---|
| Senha do dashboard | Hash **scrypt** com salt aleatório próprio por senha + parâmetros de custo explícitos. `DASHBOARD_PASSWORD_HASH` no env guarda o hash completo (formato auto-descritivo, salt e parâmetros inclusos — ver abaixo), nunca a senha em texto puro. |
| `SESSION_SECRET` | Variável **independente** da senha — 32+ bytes aleatórios, gerada separadamente (`crypto.randomBytes(32)` ou `openssl rand -hex 32`), usada só pra assinar o token de sessão (HMAC-SHA256). **Nunca derivada da senha nem do hash da senha** — comprometer uma não compromete a outra, e não existe nenhuma relação matemática entre as duas. |
| Token de sessão | `payload = { iat, exp }` (sem dado sensível dentro — nunca a senha, nunca o hash) assinado por HMAC-SHA256 com `SESSION_SECRET`. **Sem tabela de sessão no banco** — stateless, compatível com "sem models novos". |
| Comparação | Senha: deriva o scrypt da senha recebida com o MESMO salt/parâmetros do hash armazenado, depois compara os dois buffers de resultado com `crypto.timingSafeEqual()` — nunca `===`/`Buffer.equals()`. Assinatura do token: mesma coisa, `crypto.timingSafeEqual()` explícito nunca `===` comparando bytes de assinatura. |
| Cookie | `HttpOnly` (JS do navegador não lê) + `Secure` (só em produção — condicional no ambiente) + `SameSite=Lax` + `Max-Age` alinhado ao `exp` do payload assinado. **A senha nunca vai dentro do cookie, em hash ou texto puro** — só o token de sessão assinado (`{iat,exp}` + assinatura). |
| Proteção server-side | `middleware.js` cobrindo **`app/**` e `app/api/**`** — inclui as rotas de API diretamente, não só páginas (um atacante pode ir direto na API sem passar pela tela). |
| Rotas liberadas explicitamente | A própria página/rota de login, e os assets estáticos do Next (`_next/static/*`, `favicon.ico`) — sem isso, o middleware bloquearia a própria tela de login, travando o acesso. Lista de allowlist explícita no `middleware.js`, não um "bloqueia tudo exceto o que eu lembrar depois". |
| Webhook do Telegram | **Fora** dessa sessão web inteiramente — não usa cookie nem senha de dashboard. Protegido só por `TELEGRAM_WEBHOOK_SECRET` (header `X-Telegram-Bot-Api-Secret-Token`) + `OWNER_CHAT_ID` (allowlist de quem o bot processa), como já estabelecido. |
| Rate limit do login | Proposta mínima, sem infra nova: um contador de tentativas falhas embutido num cookie **assinado** (mesmo HMAC do item acima) — cada falha incrementa um contador com timestamp; N falhas em M minutos força espera exponencial antes de aceitar a próxima tentativa. **Limitação honesta**: funções serverless da Vercel são efêmeras entre invocações — uma solução em memória (ex: `Map` no processo) não persiste de forma confiável entre requests/cold starts, por isso o contador precisa estar no cookie assinado (client-side, mas à prova de adulteração pela assinatura), não em memória do servidor. Um rate limit robusto de verdade precisaria de um storage externo (Vercel KV/Upstash Redis) — deixo isso como upgrade futuro, não implemento agora: é uma dependência nova pra um app pessoal de URL obscura, onde o risco real de força bruta é baixo. |

### Formato do hash e script de geração (documentado, ainda não criado)

Formato auto-descritivo (guarda os parâmetros junto, pra poder mudar `N`/`r`/`p` no
futuro sem invalidar hashes antigos):
```
scrypt$<N>$<r>$<p>$<salt em hex>$<hash em hex>
```
Parâmetros recomendados (os mesmos do exemplo oficial da documentação do Node):
`N=16384` (2¹⁴), `r=8`, `p=1`, `keylen=64`.

Script planejado — `scripts/generate-password-hash.mjs` (**não criado ainda**,
só desenhado, é read-only no sentido de não tocar o banco — só imprime um valor
pra você colar na env var):
```js
import { scryptSync, randomBytes } from "node:crypto";

const password = process.argv[2];
if (!password) {
  console.error("uso: node scripts/generate-password-hash.mjs <senha>");
  process.exit(1);
}
const N = 16384, r = 8, p = 1, keylen = 64;
const salt = randomBytes(16);
const hash = scryptSync(password, salt, keylen, { N, r, p });
console.log(`scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${hash.toString("hex")}`);
```
Uso: `node scripts/generate-password-hash.mjs "sua senha aqui"` → cola a saída em
`DASHBOARD_PASSWORD_HASH` na Vercel. A senha em si nunca é salva em lugar nenhum —
só o hash resultante é impresso; vale limpar o histórico do shell depois de rodar
o comando, já que a senha em texto puro passa pelos argumentos do processo.

Verificação no login (pseudo-código da rota, quando implementada):
```js
import { scryptSync, timingSafeEqual } from "node:crypto";

function verifyPassword(password, storedHash) {
  const [, N, r, p, saltHex, hashHex] = storedHash.split("$");
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = scryptSync(password, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
```

Novas env vars: `DASHBOARD_PASSWORD_HASH` (formato acima), `SESSION_SECRET`
(hex/base64 aleatório, independente).

Nada disso foi implementado ainda — fica registrado como o desenho aprovado pra
quando entrarmos na fase de implementação de segurança.

---

## Testes formalizados nesta rodada

- **`freeMoney` não muda entre `funded` e `settled`** (seção 5, Estado B → C) —
  teste unitário puro: monta o cenário do Tattoo em memória, calcula `freeMoney`
  nos dois estados, afirma que são iguais. É a prova automatizada de que o
  lifecycle de `ConfirmedCommitment`/`Reserve` não gera dupla contagem.
- **`classifyConfirmedCommitment`** (seção 7) — os 4 casos listados ali (regra B
  sem funding antes da renda; regra C fundado depois da renda; "future" sem
  funding depois da renda; `settled`/`cancelled` sempre `not_applicable`), cada um
  um teste unitário puro, sem banco.
- **`classifyCardBill`/`classifyBill`** (regra A, sempre incurred independente de
  data) — mesma ideia, dado fabricado, sem banco.
- **Relatório read-only Float→Decimal** (seção 1) — não é bem um teste automatizado,
  é uma inspeção manual obrigatória antes de aprovar a migration de tipo.
- Os testes de integração no branch `dev` (Reserve, CardCreditMovement,
  ConfirmedCommitment) e a checagem de regressão arquitetural
  (`cashFlowProjection.startingBalance` nunca é `freeMoney`) continuam como
  definidos anteriormente — sem mudança nesta rodada.

---

## Migration plan (ordem — nada disso roda ainda)

1. **Relatório read-only** Float→Decimal (desenhado na seção 1) — roda primeiro,
   sem escrever nada, você revisa antes de aprovar o próximo passo.
2. **Decimal/NUMERIC** — converte os campos `Float` existentes (com `ROUND`
   explícito, baseado no relatório do passo 1) + `lib/money.js` + o refactor das
   libs de cálculo pra Decimal-first.
3. **`AppSettings`**.
4. **`DataConfidence` enum** + campo `confidence` nos 12 models da seção 8.
5. **`Reserve` + `ReserveMovement`** (com `ReserveMovementKind` enum e `CHECK
   (amount > 0)`).
6. **`CardCreditMovement`** (com `CardCreditMovementKind` enum).
7. **`ConfirmedCommitment`**.
8. **`Contingency`**.
9. **`CategoryBudget`** (cycleStart + `@@unique`).
10. **`Bill.paidAmount`/`isEstimated`/`estimatedAmount`** (pendente desde o
    blueprint original).
11. **`ExternalInstallmentPlan` + `ExternalInstallment`** (idem).
12. **`Receivable`** (idem).

Todas aditivas. Cada uma testada primeiro no branch `dev` do Neon (Fase 2A) antes
de `migrate deploy` em produção.

---

## Status de implementação — Fase 5.3C (autenticação, seção 11)

A seção 11 (autenticação) foi **implementada** na Fase 5.3C, seguindo fielmente
o desenho acima, com um único desvio técnico necessário: o separador do hash
de senha mudou de `$` (`scrypt$N$r$p$salt$hash`) para `:`
(`scrypt:N:r:p:salt:hash`) — o loader de env do Next.js (`@next/env`) faz
interpolação de `$NOME`/`${NOME}` nos valores de `.env`, mesmo dentro de aspas
simples, o que corrompia silenciosamente um hash com `$` (cada `$8`/`$1`/etc.
virava string vazia por não existir env var com esse nome). O resto do desenho
(scrypt nativo, `SESSION_SECRET` independente, token `{iat,exp}` assinado por
HMAC-SHA256, cookie HttpOnly+Secure+SameSite=Lax, `middleware.js` cobrindo
`app/**`+`app/api/**`, webhook do Telegram fora da sessão web, rate-limit via
cookie assinado) foi implementado exatamente como planejado. Ver
`lib/auth/**`, `middleware.js`, `docs/fase53c-prod-config-manifest.md`.

## Decisões fechadas nesta rodada

1. **Horizonte de `confirmedCommitments`** — `nextIncomeDate` (próxima renda
   esperada). Regra final: incurred agora quando (A) é incurred liability
   independente de data, OU (B) `ConfirmedCommitment` com `dueDate <=
   nextIncomeDate`, OU (C) `ConfirmedCommitment` já `funded` mesmo vencendo depois.
   Confirmado-mas-não-fundado vencendo depois da próxima renda não reduz `freeMoney`
   hoje — vira `comprometimentoFuturo` e aparece na projeção. Formalizado no
   `obligationClassifier` (seção 7) com os 4 casos de teste unitário listados lá.
2. **`crypto.scrypt` nativo** (não `bcryptjs`) — seção 11 reescrita com formato de
   hash auto-descritivo, script de geração desenhado (não criado ainda), e
   verificação via `timingSafeEqual`.
3. **`CONFIRMED` ≠ `FUNDED` ≠ `SETTLED`** — reforçado explicitamente no início da
   seção 5, com a exigência de `prisma.$transaction` nas duas transições sensíveis
   (funding+ReserveMovement; settlement+Expense), mesmo padrão já usado em
   `payBill` desde a Fase 1.

## Dúvidas realmente bloqueantes

Nenhuma. O blueprint está fechado do meu lado nesta rodada.

Nenhuma migration, nenhum dado alterado, nenhum deploy, nenhum snapshot — como
pedido.
