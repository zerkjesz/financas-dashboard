// Fase 4.1.2 — Card Liability Gate. Testes puros (sem banco) de
// resolveCurrentRelevantCardBillId + classifyCardBill, com o cenário EXATO do
// pedido: Card closingDay=4/dueDay=11, as of 04/09/2026, fatura de setembro já
// quitada, outubro com saldo. Nenhum dado real do usuário.
import { resolveCurrentRelevantCardBillId } from "../lib/freeMoney.js";
import { classifyCardBill, OBLIGATION_CLASS } from "../lib/obligationClassifier.js";
import { money, compareMoney } from "../lib/money.js";

let passed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`✅ ${name}`);
  } else {
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
    process.exitCode = 1;
  }
}
function d(s) {
  return new Date(`${s}T00:00:00.000Z`);
}
function eq(a, b) {
  return compareMoney(a, b) === 0;
}

console.log("--- Testes puros: Card Liability Gate (Fase 4.1.2) ---\n");

// Fixture base do cenário exato do pedido (item 1). closesAt em ordem
// cronológica clara: set(04/09) < out(04/10) < nov(04/11) < dez < jan < fev.
function makeBills({ setStatus, outStatus, novStatus } = {}) {
  return [
    { id: "set", totalAmount: money(1859.01), paidAmount: setStatus === "paid" ? money(1859.01) : setStatus === "partially_paid" ? money(1859.01 - 200) : money(0), closesAt: d("2026-09-04") },
    { id: "out", totalAmount: money(716.97), paidAmount: outStatus === "paid" ? money(716.97) : money(0), closesAt: d("2026-10-04") },
    { id: "nov", totalAmount: money(479.38), paidAmount: novStatus === "paid" ? money(479.38) : money(0), closesAt: d("2026-11-04") },
    { id: "dez", totalAmount: money(60.6), paidAmount: money(0), closesAt: d("2026-12-04") },
    { id: "jan", totalAmount: money(60.6), paidAmount: money(0), closesAt: d("2027-01-04") },
    { id: "fev", totalAmount: money(60.6), paidAmount: money(0), closesAt: d("2027-02-04") },
  ];
}

// ============================================================================
// Item 1 — cenário exato: set PAID, out/nov/dez/jan/fev unpaid.
// ============================================================================
{
  const bills = makeBills({ setStatus: "paid" });
  const currentId = resolveCurrentRelevantCardBillId(bills);
  check("cenário exato: fatura relevante = outubro (não setembro, já paga; não novembro, muito cedo)", currentId === "out", currentId);

  const classifications = Object.fromEntries(bills.map((b) => [b.id, classifyCardBill(b, { isCurrentRelevant: b.id === currentId })]));
  check("set (paga) = SETTLED", classifications.set === OBLIGATION_CLASS.SETTLED);
  check("out (relevante) = INCURRED_LIABILITY (716.97 entra)", classifications.out === OBLIGATION_CLASS.INCURRED_LIABILITY);
  check("nov = FUTURE_OBLIGATION (479.38 NÃO entra em incurred)", classifications.nov === OBLIGATION_CLASS.FUTURE_OBLIGATION);
  check("dez/jan/fev = FUTURE_OBLIGATION", ["dez", "jan", "fev"].every((id) => classifications[id] === OBLIGATION_CLASS.FUTURE_OBLIGATION));

  const incurredTotal = bills
    .filter((b) => classifications[b.id] === OBLIGATION_CLASS.INCURRED_LIABILITY)
    .reduce((sum, b) => sum.plus(b.totalAmount.minus(b.paidAmount)), money(0));
  check("incurredLiabilities do cenário = exatamente 716.97 (não 1378.15 de limite usado, não a soma de tudo)", eq(incurredTotal, 716.97), incurredTotal.toString());
}

// ============================================================================
// Item 7 — Teste A: Set paid, Out unpaid, Nov unpaid → incurred=716.97, future inclui 479.38.
// ============================================================================
{
  const bills = makeBills({ setStatus: "paid" }).slice(0, 3); // só set/out/nov
  const currentId = resolveCurrentRelevantCardBillId(bills);
  check("A) fatura relevante = out", currentId === "out");
  const clsOut = classifyCardBill(bills[1], { isCurrentRelevant: bills[1].id === currentId });
  const clsNov = classifyCardBill(bills[2], { isCurrentRelevant: bills[2].id === currentId });
  check("A) incurred = 716.97 (out)", clsOut === OBLIGATION_CLASS.INCURRED_LIABILITY);
  check("A) future inclui 479.38 (nov)", clsNov === OBLIGATION_CLASS.FUTURE_OBLIGATION);
}

// ============================================================================
// Item 7 — Teste B: Set partially_paid saldo 200, Out unpaid → incurred=200, Out future.
// ============================================================================
{
  const bills = makeBills({ setStatus: "partially_paid" }).slice(0, 2); // set/out
  const currentId = resolveCurrentRelevantCardBillId(bills);
  check("B) fatura relevante = set (ainda tem saldo de 200, é a primeira não liquidada)", currentId === "set", currentId);
  const clsSet = classifyCardBill(bills[0], { isCurrentRelevant: bills[0].id === currentId });
  const clsOut = classifyCardBill(bills[1], { isCurrentRelevant: bills[1].id === currentId });
  check("B) set (relevante) = INCURRED_LIABILITY", clsSet === OBLIGATION_CLASS.INCURRED_LIABILITY);
  const remainingSet = bills[0].totalAmount.minus(bills[0].paidAmount);
  check("B) saldo restante de set = 200", eq(remainingSet, 200), remainingSet.toString());
  check("B) out = FUTURE_OBLIGATION", clsOut === OBLIGATION_CLASS.FUTURE_OBLIGATION);
}

// ============================================================================
// Item 7 — Teste C: Set/Out/Nov todas unpaid → somente Set incurred.
// ============================================================================
{
  const bills = makeBills({}); // nenhuma paga
  const currentId = resolveCurrentRelevantCardBillId(bills);
  check("C) fatura relevante = set (a mais antiga não liquidada)", currentId === "set", currentId);
  const classifications = Object.fromEntries(bills.map((b) => [b.id, classifyCardBill(b, { isCurrentRelevant: b.id === currentId })]));
  check("C) somente set é INCURRED_LIABILITY", classifications.set === OBLIGATION_CLASS.INCURRED_LIABILITY);
  check("C) out/nov/dez/jan/fev são todas FUTURE_OBLIGATION", ["out", "nov", "dez", "jan", "fev"].every((id) => classifications[id] === OBLIGATION_CLASS.FUTURE_OBLIGATION));
}

// ============================================================================
// Item 7 — Teste D: Set paid, Out paid, Nov unpaid → Nov incurred.
// ============================================================================
{
  const bills = makeBills({ setStatus: "paid", outStatus: "paid" }).slice(0, 3);
  const currentId = resolveCurrentRelevantCardBillId(bills);
  check("D) fatura relevante = nov (set e out já quitadas)", currentId === "nov", currentId);
  const clsNov = classifyCardBill(bills[2], { isCurrentRelevant: bills[2].id === currentId });
  check("D) nov = INCURRED_LIABILITY", clsNov === OBLIGATION_CLASS.INCURRED_LIABILITY);
}

// ============================================================================
// Item 7 — Teste E: zero-balance bill não vira liability.
// ============================================================================
{
  const bills = [
    { id: "zero", totalAmount: money(0), paidAmount: money(0), closesAt: d("2026-09-04") },
    { id: "out", totalAmount: money(716.97), paidAmount: money(0), closesAt: d("2026-10-04") },
  ];
  const currentId = resolveCurrentRelevantCardBillId(bills);
  check("E) fatura de saldo zero é ignorada — relevante = out", currentId === "out", currentId);
  const clsZero = classifyCardBill(bills[0], { isCurrentRelevant: bills[0].id === currentId });
  check("E) bill de saldo zero = SETTLED, nunca liability (mesmo se marcada isCurrentRelevant por engano)", classifyCardBill(bills[0], { isCurrentRelevant: true }) === OBLIGATION_CLASS.SETTLED && clsZero === OBLIGATION_CLASS.SETTLED);
}

// ============================================================================
// Item 7 — Teste F: ordem não depende da ordem em que as rows vieram do banco.
// ============================================================================
{
  const billsInOrder = makeBills({ setStatus: "paid" });
  const billsShuffled = [billsInOrder[4], billsInOrder[1], billsInOrder[5], billsInOrder[0], billsInOrder[3], billsInOrder[2]]; // embaralhado
  const idInOrder = resolveCurrentRelevantCardBillId(billsInOrder);
  const idShuffled = resolveCurrentRelevantCardBillId(billsShuffled);
  check("F) resultado é o mesmo independente da ordem de entrada (ambos = out)", idInOrder === "out" && idShuffled === "out", `emOrdem=${idInOrder}, embaralhado=${idShuffled}`);
}

// ============================================================================
// Cartão sem nenhuma fatura não liquidada — nenhuma incurred.
// ============================================================================
{
  const bills = makeBills({ setStatus: "paid", outStatus: "paid", novStatus: "paid" }).map((b) => ({ ...b, paidAmount: b.id === "dez" || b.id === "jan" || b.id === "fev" ? b.paidAmount : b.totalAmount }));
  // marca dez/jan/fev também como pagas pra este teste específico:
  const allPaid = bills.map((b) => ({ ...b, paidAmount: b.totalAmount }));
  const currentId = resolveCurrentRelevantCardBillId(allPaid);
  check("todas as faturas quitadas: nenhuma fatura relevante (null)", currentId === null, String(currentId));
}

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) console.log("Alguns testes falharam — ver ❌ acima.");
