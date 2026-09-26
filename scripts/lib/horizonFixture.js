// Fase 9.1.2 — fixture de HORIZONTE: faz a "próxima renda" do DEV ser 24/10/2026 quando o relógio do teste
// é 25/09/2026 (no DEV a renda de 24/09 está sem Income realizado => OVERDUE e o horizonte colapsa para hoje).
// Cria UM Income MARK vinculado à ocorrência 24/09 da regra de salário; a limpeza é feita por quem chama
// (deleteMany por description contém MARK). Nunca toca em linha real.
import { getNextIncomeInfo } from "../../lib/incomeHorizon.js";

export async function realizeSeptemberSalary(prisma, { mark, accountId, now }) {
  const next = await getNextIncomeInfo({ now });
  if (!next.recurringRuleId || next.status !== "OVERDUE") return { applied: false, next };
  const occ = new Date(Date.UTC(next.expectedDate.getUTCFullYear(), next.expectedDate.getUTCMonth(), next.expectedDate.getUTCDate()));
  await prisma.income.create({
    data: { amount: 1, description: `${mark} salário realizado (fixture de horizonte)`, category: "Salário", accountId, recurringRuleId: next.recurringRuleId, isRecurring: true, recurringOccurrenceDate: occ, source: "manual", confidence: "CONFIRMED", occurredAt: new Date("2026-09-24T12:00:00.000Z") },
  });
  const after = await getNextIncomeInfo({ now });
  return { applied: true, next: after };
}
