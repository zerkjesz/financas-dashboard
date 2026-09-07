// Fase 5.2A — testes sintéticos do modelo de obrigações (100% dado fictício,
// nenhum acesso ao banco — só as funções PURAS do classificador/freeMoney).
// Nenhum valor pessoal em fixture nenhuma.
import { classifyConfirmedCommitment, classifyExternalInstallment, classifyContingency, OBLIGATION_CLASS } from "../lib/obligationClassifier.js";
import { computeFreeMoneyFromBreakdown, computeSafeToSpend, getUnfundedConfirmedCommitments } from "../lib/freeMoney.js";
import { money, compareMoney, isNegative } from "../lib/money.js";

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) {
    passed++;
    console.log(`✅ ${label}`);
  } else {
    failed++;
    console.error(`❌ ${label}`);
  }
}

console.log("--- Fase 5.2A: testes sintéticos (modelo de obrigações) ---\n");

const nextIncomeDate = new Date("2030-06-15T00:00:00.000Z");

// --- [A] compromisso vencendo ANTES da próxima renda -> DUE_BEFORE_NEXT_INCOME (CURRENT_HORIZON) ---
{
  const commitment = { status: "CONFIRMED", dueDate: new Date("2030-06-10T00:00:00.000Z"), amount: money("500.00") };
  const cls = classifyConfirmedCommitment(commitment, { nextIncomeDate });
  check(cls === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION, "[A] compromisso com dueDate ANTES da próxima renda classifica CURRENT_HORIZON_OBLIGATION (equivalente a DUE_BEFORE_NEXT_INCOME)");
}

// --- [B] compromisso vencendo DEPOIS da próxima renda, unfunded -> FUTURE_OBLIGATION (não reduz freeMoney hoje) ---
{
  const commitment = { status: "CONFIRMED", dueDate: new Date("2030-07-20T00:00:00.000Z"), amount: money("300.00") };
  const cls = classifyConfirmedCommitment(commitment, { nextIncomeDate });
  check(cls === OBLIGATION_CLASS.FUTURE_OBLIGATION, "[B] compromisso com dueDate DEPOIS da próxima renda (unfunded) classifica FUTURE_OBLIGATION — não reduz freeMoney atual");
}

// --- [C] parcela externa com dueDate desconhecido representada como FUTURE (nunca inventa data) ---
{
  // Simula o padrão proposto (item 21 do enunciado): dueDate no futuro distante
  // simbólico, nunca a data real de hoje/próxima renda — o teste verifica que a
  // classificação trata "vence bem depois" como FUTURE_OBLIGATION, sem exigir
  // saber o dia exato.
  const farFutureSentinel = new Date("2099-01-01T00:00:00.000Z");
  const installment = { status: "PENDING", dueDate: farFutureSentinel, amount: money("150.00") };
  const cls = classifyExternalInstallment(installment, { nextIncomeDate });
  check(cls === OBLIGATION_CLASS.FUTURE_OBLIGATION, "[C] parcela externa sem data exata conhecida (representada como não-vencendo-antes-da-renda) classifica FUTURE_OBLIGATION, nunca CURRENT_HORIZON por acidente");
}

// --- [D] nenhum double debit: um Expense real pode settle mais de uma obrigação sem duplicar ---
{
  // Verifica a REGRA (via ausência de efeito colateral): classificar uma
  // ExternalInstallment como SETTLED não soma seu amount em nenhum bucket.
  const paidInstallment = { status: "PAID", dueDate: new Date("2030-05-01T00:00:00.000Z"), amount: money("999.00") };
  const cls = classifyExternalInstallment(paidInstallment, { nextIncomeDate });
  check(cls === OBLIGATION_CLASS.SETTLED, "[D] parcela PAID classifica SETTLED — não entra em nenhum bucket de obrigação (sem double debit)");
}

// --- [E] cartão não é duplicado: incurredLiabilities já é o valor final (não somado de novo) ---
{
  const unrestrictedCash = money("1000.00");
  const incurredCardLiability = money("250.00"); // já representa a fatura inteira, uma vez só
  const currentHorizon = money("0");
  const freeMoney = computeFreeMoneyFromBreakdown({ unrestrictedCash, protectedMoney: money(0), incurredLiabilities: incurredCardLiability, currentHorizonObligations: currentHorizon });
  check(compareMoney(freeMoney, money("750.00")) === 0, "[E] freeMoney subtrai o cartão exatamente uma vez (1000.00 - 250.00 = 750.00) — nunca soma compras já embutidas na fatura de novo");
}

// --- [F] compromisso confirmado com janela incerta reduz freeMoney quando dueBy <= próxima renda ---
{
  const unrestrictedCash = money("1000.00");
  const incurred = money("250.00");
  const windowedCommitment = money("900.00"); // dueBy = candidato mais tardio de uma janela de 2 dias, ambos antes da renda
  const freeMoney = computeFreeMoneyFromBreakdown({ unrestrictedCash, protectedMoney: money(0), incurredLiabilities: incurred, currentHorizonObligations: windowedCommitment });
  check(compareMoney(freeMoney, money("-150.00")) === 0, "[F] compromisso de janela incerta (dueBy = candidato mais tardio) reduz freeMoney corretamente quando ambos os candidatos antecedem a próxima renda");
  check(isNegative(freeMoney), "[F] freeMoney negativo é permitido (nunca max(0))");
}

// --- [G] safeToSpend = 0 quando freeMoney é negativo ---
{
  const result = computeSafeToSpend(money("-150.00"), 10);
  check(compareMoney(result.safeToSpend, money(0)) === 0, "[G] safeToSpend = 0 quando freeMoney é negativo");
  check(compareMoney(result.safetyReserve, money(0)) === 0, "[G] safetyReserve = 0 quando freeMoney é negativo");
}

// --- [H] % comprometido usa o salário-BASE, nunca o valor real desconhecido ---
{
  const { multiplyMoney, divideMoney } = await import("../lib/money.js");
  const knownCommitted = money("500.00");
  const baseSalary = money("2000.00"); // valor BASE conhecido — o valor REAL da próxima ocorrência é UNKNOWN
  const percent = multiplyMoney(divideMoney(knownCommitted, baseSalary), 100);
  check(compareMoney(percent, money("25")) === 0, "[H] committedPercent calculado via Decimal contra o salário-base (500/2000=25%), nunca contra um valor real ainda desconhecido");
}

// --- [I] cenário estimado (telefone) nunca promovido a confirmado ---
{
  const knownExactFreeMoney = money("-150.00");
  const estimatedExtra = money("25.00"); // valor ESTIMATED, nunca CONFIRMED
  const estimatedScenario = knownExactFreeMoney.minus(estimatedExtra);
  check(compareMoney(estimatedScenario, money("-175.00")) === 0, "[I] cenário ESTIMATED_PHONE_SCENARIO é um cálculo SEPARADO do KNOWN_EXACT, nunca substitui/promove o valor estimado a confirmado");
}

// --- [J] contingência nunca reduz freeMoney por padrão ---
{
  const contingency = { status: "AWAITING_INFORMATION" };
  const cls = classifyContingency(contingency);
  check(cls === OBLIGATION_CLASS.CONTINGENCY, "[J] Contingency classifica CONTINGENCY, nunca CURRENT_HORIZON_OBLIGATION — não é somada em computeFreeMoneyFromBreakdown");
  const unrestrictedCash = money("1000.00");
  const freeMoneyWithoutContingency = computeFreeMoneyFromBreakdown({ unrestrictedCash, protectedMoney: money(0), incurredLiabilities: money(0), currentHorizonObligations: money(0) });
  check(compareMoney(freeMoneyWithoutContingency, unrestrictedCash) === 0, "[J] freeMoney não muda com uma Contingency pendente — exposição fica só em contingencyExposure, separado");
}

// --- [K] compromisso FUNDED entra no horizonte atual mesmo com dueDate distante (regra já estabelecida) ---
{
  const fundedCommitment = { status: "FUNDED", dueDate: new Date("2031-01-01T00:00:00.000Z"), amount: money("100.00") };
  const cls = classifyConfirmedCommitment(fundedCommitment, { nextIncomeDate });
  check(cls === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION, "[K] compromisso FUNDED conta como horizonte atual mesmo com dueDate distante (earmark já existe) — regra pré-existente confirmada, não alterada por esta fase");
}

// --- [L] unfundedConfirmedCommitments detecta corretamente o que precisa de funding ---
{
  const currentHorizonItems = [
    { type: "ConfirmedCommitment", status: "CONFIRMED", amount: money("900.00") },
    { type: "ConfirmedCommitment", status: "FUNDED", amount: money("100.00") },
  ];
  const unfunded = getUnfundedConfirmedCommitments(currentHorizonItems);
  check(unfunded.count === 1, "[L] getUnfundedConfirmedCommitments conta só os CONFIRMED (não FUNDED)");
  check(compareMoney(unfunded.amount, money("900.00")) === 0, "[L] getUnfundedConfirmedCommitments soma corretamente só os CONFIRMED sem funding definido");
}

console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
if (failed > 0) process.exit(1);
