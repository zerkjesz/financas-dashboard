// Fase 4.1, item 8/24 — testes puros (sem banco) das fórmulas de freeMoney/
// safeToSpend. Mesmo estilo de scripts/test-money.mjs.
import { computeFreeMoneyFromBreakdown, computeSafeToSpend } from "../lib/freeMoney.js";
import { compareMoney, serializeMoney, money } from "../lib/money.js";

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
function eq(a, b) {
  return compareMoney(a, b) === 0;
}

console.log("--- Testes puros: fórmula freeMoney/safeToSpend ---\n");

// ---- Item 8, exemplo 1: freeMoney positivo ----
{
  const freeMoney = computeFreeMoneyFromBreakdown({
    unrestrictedCash: 10000,
    protectedMoney: 4000,
    incurredLiabilities: 1000,
    currentHorizonObligations: 2000,
  });
  check("freeMoney positivo: 10000 - 4000 - 1000 - 2000 = 3000", eq(freeMoney, 3000), serializeMoney(freeMoney).toString());

  const safe = computeSafeToSpend(freeMoney, 10);
  check("safetyReserve = 3000 * 10% = 300", eq(safe.safetyReserve, 300), serializeMoney(safe.safetyReserve).toString());
  check("safeToSpend = 3000 - 300 = 2700", eq(safe.safeToSpend, 2700), serializeMoney(safe.safeToSpend).toString());
}

// ---- Item 8, exemplo 2: freeMoney negativo ----
{
  const freeMoney = computeFreeMoneyFromBreakdown({
    unrestrictedCash: 5000,
    protectedMoney: 4000,
    incurredLiabilities: 1500,
    currentHorizonObligations: 500,
  });
  check("freeMoney negativo: 5000 - 4000 - 1500 - 500 = -1000", eq(freeMoney, -1000), serializeMoney(freeMoney).toString());
  check("freeMoney negativo NÃO é truncado em 0 (nunca max(0) aqui)", freeMoney.isNegative());

  const safe = computeSafeToSpend(freeMoney, 10);
  check("safeToSpend = 0 quando freeMoney <= 0", eq(safe.safeToSpend, 0), serializeMoney(safe.safeToSpend).toString());
  check("safetyReserve = 0 quando freeMoney <= 0", eq(safe.safetyReserve, 0), serializeMoney(safe.safetyReserve).toString());
}

// ---- freeMoney exatamente zero ----
{
  const freeMoney = computeFreeMoneyFromBreakdown({ unrestrictedCash: 1000, protectedMoney: 500, incurredLiabilities: 300, currentHorizonObligations: 200 });
  check("freeMoney == 0 é tratado como <= 0 (safeToSpend = 0)", eq(freeMoney, 0));
  const safe = computeSafeToSpend(freeMoney, 10);
  check("safeToSpend = 0 quando freeMoney == 0 exatamente", eq(safe.safeToSpend, 0));
}

// ---- Item 9: lifecycle de funding por Reserve — aritmética pura A/B/C ----
// (o lifecycle real, com Reserve/Commitment persistidos, é testado em
// scripts/test-financial-engine-integration.mjs; aqui só a FÓRMULA.)
{
  // Estado A: cash=8730, protectedMoney(Reserve)=7000, currentHorizon(Commitment)=2465.
  const freeMoneyA = computeFreeMoneyFromBreakdown({ unrestrictedCash: 8730, protectedMoney: 7000, incurredLiabilities: 0, currentHorizonObligations: 2465 });
  check("Estado A: freeMoney = 8730 - 7000 - 2465 = -735", eq(freeMoneyA, -735), serializeMoney(freeMoneyA).toString());

  // Estado B: commitment FUNDED via Reserve — Reserve libera 2465 (RELEASE),
  // protectedMoney cai pra 4535; commitment CONTINUA contando como obrigação
  // (FUNDED != pago). freeMoney sobe porque o dinheiro antes protegido virou
  // disponível pra ESSE compromisso especificamente — não é dinheiro dobrado.
  const freeMoneyB = computeFreeMoneyFromBreakdown({ unrestrictedCash: 8730, protectedMoney: 4535, incurredLiabilities: 0, currentHorizonObligations: 2465 });
  check("Estado B: freeMoney = 8730 - 4535 - 2465 = 1730 (funding libera a reserva, não soma duas vezes)", eq(freeMoneyB, 1730), serializeMoney(freeMoneyB).toString());

  // Estado C: pagamento real do commitment — cash cai pro valor pago,
  // commitment SETTLED (sai de currentHorizonObligations).
  const freeMoneyC = computeFreeMoneyFromBreakdown({ unrestrictedCash: 6265, protectedMoney: 4535, incurredLiabilities: 0, currentHorizonObligations: 0 });
  check("Estado C: freeMoney = 6265 - 4535 = 1730 (economicamente estável em relação a B)", eq(freeMoneyC, 1730), serializeMoney(freeMoneyC).toString());
  check("B → C: freeMoney permanece estável (1730 == 1730)", eq(freeMoneyB, freeMoneyC));
}

// ---- Cenário sintético completo (item 25) — só a fórmula final ----
{
  // totalBalances=10600, unrestrictedCash=10000, restrictedBalance=600,
  // protectedMoney=4000, incurred=1200, currentHorizon=1800.
  const freeMoney = computeFreeMoneyFromBreakdown({ unrestrictedCash: 10000, protectedMoney: 4000, incurredLiabilities: 1200, currentHorizonObligations: 1800 });
  check("Cenário sintético: freeMoney = 10000 - 4000 - 1200 - 1800 = 3000", eq(freeMoney, 3000), serializeMoney(freeMoney).toString());
  const safe = computeSafeToSpend(freeMoney, 10);
  check("Cenário sintético: safeToSpend = 2700", eq(safe.safeToSpend, 2700), serializeMoney(safe.safeToSpend).toString());
}

// ---- Precisão: tudo em Decimal, nunca number no meio ----
{
  const freeMoney = computeFreeMoneyFromBreakdown({ unrestrictedCash: "10000.37", protectedMoney: "4000.13", incurredLiabilities: "1000.11", currentHorizonObligations: "2000.09" });
  check("precisão decimal exata com centavos (10000.37-4000.13-1000.11-2000.09=3000.04)", eq(freeMoney, "3000.04"), serializeMoney(freeMoney).toString());
  check("computeFreeMoneyFromBreakdown devolve Decimal, não number", typeof freeMoney !== "number" && typeof freeMoney.toFixed === "function");
}

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) console.log("Alguns testes falharam — ver ❌ acima.");
