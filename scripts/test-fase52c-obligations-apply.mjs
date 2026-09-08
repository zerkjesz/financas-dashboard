// Fase 5.2C — teste específico (item 34): a numeração das parcelas restantes
// preserva a posição ORIGINAL da dívida (nunca renumerada a partir de 1).
// 100% fictício (MARK = "TESTE_FASE52C"), fixture criada/limpa em finally.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { createExternalInstallmentPlan } from "../lib/externalInstallments.js";

const MARK = "TESTE_FASE52C";
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

async function main() {
  console.log("--- Fase 5.2C: numeração original preservada (não renumerada a partir de 1) ---\n");

  // Exemplo fictício do próprio enunciado: total=8, paid=3 -> children devem
  // ser 4,5,6,7,8 — nunca 1,2,3,4,5.
  const plan = await createExternalInstallmentPlan({
    description: `${MARK} plano`,
    creditor: `${MARK} credor`,
    installmentValue: 25,
    installmentCount: 8,
    alreadyPaidCount: 3,
    dueTiming: "AFTER_NEXT_INCOME",
  });
  try {
    const numbers = plan.installments.map((i) => i.number).sort((a, b) => a - b);
    check(JSON.stringify(numbers) === JSON.stringify([4, 5, 6, 7, 8]), `[numbering] total=8, paid=3 -> children = [${numbers.join(",")}] (esperado 4,5,6,7,8)`);
    check(plan.installments.length === 5, "[numbering] exatamente 5 children criadas (installmentCount - alreadyPaidCount), nenhuma histórica 1..3");
    const noHistorical = await prisma.externalInstallment.count({ where: { planId: plan.id, number: { lte: 3 } } });
    check(noHistorical === 0, "[numbering] nenhuma row histórica (números 1..3) foi criada pra 'completar' a sequência");

    // Caso-limite: alreadyPaidCount = 0 (comportamento antigo, pré-Fase 5.2C) continua igual.
  } finally {
    await prisma.externalInstallmentPlan.delete({ where: { id: plan.id } });
  }

  const planDefault = await createExternalInstallmentPlan({
    description: `${MARK} plano default`,
    creditor: `${MARK} credor`,
    installmentValue: 10,
    installmentCount: 3,
    dueTiming: "AFTER_NEXT_INCOME",
  });
  try {
    const numbers = planDefault.installments.map((i) => i.number).sort((a, b) => a - b);
    check(JSON.stringify(numbers) === JSON.stringify([1, 2, 3]), "[numbering] alreadyPaidCount omitido (default 0) continua numerando 1..N, comportamento pré-existente inalterado");
  } finally {
    await prisma.externalInstallmentPlan.delete({ where: { id: planDefault.id } });
  }

  // Rejeita alreadyPaidCount inválido.
  try {
    await createExternalInstallmentPlan({ description: `${MARK} inválido`, creditor: `${MARK} credor`, installmentValue: 10, installmentCount: 3, alreadyPaidCount: 5, dueTiming: "AFTER_NEXT_INCOME" });
    check(false, "[numbering] alreadyPaidCount > installmentCount deveria lançar erro");
  } catch {
    check(true, "[numbering] alreadyPaidCount > installmentCount lança erro (nunca aceita silenciosamente)");
  }

  console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
  const leftover = await prisma.externalInstallmentPlan.count({ where: { description: { contains: MARK } } });
  console.log(`Limpeza confirmada: ${leftover} planos de teste remanescentes (esperado 0).`);
  await prisma.$disconnect();
  if (failed > 0 || leftover > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
