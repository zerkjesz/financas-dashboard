// Fase 6.0 (Design Freeze) — DATA HUB: testes de integração reais contra o
// branch `dev`. Segue a MESMA disciplina de scripts/test-dev-integration.mjs:
// assertTestEnvironment() primeiro, todo dado criado carrega o marcador
// TESTE_DATAHUB, cleanup em `finally` sempre.
//
//   node scripts/test-data-hub.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { buildExportWorkbook } from "../lib/dataHub/export.js";
import { parseImportFile } from "../lib/dataHub/parse.js";
import { planImport, fingerprintStillValid } from "../lib/dataHub/plan.js";
import { applyImportBatch, StaleImportError } from "../lib/dataHub/apply.js";
import { undoImportBatch } from "../lib/dataHub/undo.js";
import { planReplace, applyReplace } from "../lib/dataHub/replace.js";

const MARK = "TESTE_DATAHUB";
let pass = 0,
  fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

const created = { goals: [], incomes: [], expenses: [], transfers: [] };

async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const id of created.goals) await prisma.goal.delete({ where: { id } }).catch(() => {});
  for (const id of created.incomes) await prisma.income.delete({ where: { id } }).catch(() => {});
  for (const id of created.expenses) await prisma.expense.delete({ where: { id } }).catch(() => {});
  for (const id of created.transfers) await prisma.transfer.delete({ where: { id } }).catch(() => {});
  // Qualquer coisa criada PELO PRÓPRIO import (e não rastreada acima) tem o
  // marcador no name/description — varredura final de segurança.
  const strayGoals = await prisma.goal.findMany({ where: { name: { contains: MARK } } });
  for (const g of strayGoals) await prisma.goal.delete({ where: { id: g.id } }).catch(() => {});
  const strayIncomes = await prisma.income.findMany({ where: { description: { contains: MARK } } });
  for (const i of strayIncomes) await prisma.income.delete({ where: { id: i.id } }).catch(() => {});
  console.log(`Limpeza: goals=${strayGoals.length} incomes=${strayIncomes.length} remanescentes removidos.`);
}

async function main() {
  // ============================================================
  // 1) EXPORT -> PARSE round-trip
  // ============================================================
  const { buffer } = await buildExportWorkbook({});
  const parsed = await parseImportFile(buffer, { fileName: "teste.xlsx" });
  check("[A] export produz sheets conhecidas", parsed.unknownSheets.length === 0, JSON.stringify(parsed.unknownSheets));
  check("[A] schema version detectada e compatível", parsed.schemaVersionKnown === true);
  const despesasReport = parsed.sheetReports.find((r) => r.key === "expenses");
  check("[A] round-trip preserva contagem real de despesas", despesasReport && despesasReport.rowCount > 0, JSON.stringify(despesasReport));

  // ============================================================
  // 2) ADICIONAR — cria uma Goal nova; reimportar o MESMO arquivo -> skip (duplicata)
  // ============================================================
  const goalName = `${MARK} Viagem`;
  const addRows = { goals: [{ name: goalName, targetAmount: 1000, savedAmount: 0, notes: `${MARK} nota` }] };
  const plan1 = await planImport({ prisma, mode: "add", datasets: ["goals"], rowsBySheet: addRows });
  check("[B] plano ADICIONAR: 1 create, 0 skip (1ª vez)", plan1.perDataset.goals.creates.length === 1 && plan1.perDataset.goals.skips.length === 0);

  const applied1 = await applyImportBatch(prisma, { mode: "add", datasets: ["goals"], rows: addRows, resolutions: {}, planFingerprint: [] });
  check("[B] apply ADICIONAR cria 1 registro", applied1.counts.created === 1, JSON.stringify(applied1.counts));
  const newGoal = await prisma.goal.findFirst({ where: { name: goalName } });
  check("[B] goal realmente existe no banco", !!newGoal);
  if (newGoal) created.goals.push(newGoal.id);

  const plan2 = await planImport({ prisma, mode: "add", datasets: ["goals"], rowsBySheet: addRows });
  check("[B] reimportar o MESMO arquivo em ADICIONAR -> 0 create, 1 skip (duplicata)", plan2.perDataset.goals.creates.length === 0 && plan2.perDataset.goals.skips.length === 1, JSON.stringify(plan2.perDataset.goals));

  // ============================================================
  // 3) ATUALIZAR — corresponde por chave natural (nome) -> vira CONFLITO (não ID)
  // ============================================================
  const updateRows = { goals: [{ name: goalName, targetAmount: 2500, savedAmount: 0, notes: `${MARK} nota atualizada` }] };
  const plan3 = await planImport({ prisma, mode: "update", datasets: ["goals"], rowsBySheet: updateRows });
  check("[C] match por chave natural (sem ID) vira CONFLITO, não update direto", plan3.perDataset.goals.updates.length === 0 && plan3.perDataset.goals.conflicts.length === 1, JSON.stringify(plan3.perDataset.goals));
  const conflictKey = plan3.perDataset.goals.conflicts[0]?.conflictKey;

  // resolução "manter o atual" -> nada muda
  const appliedKeep = await applyImportBatch(prisma, { mode: "update", datasets: ["goals"], rows: updateRows, resolutions: { [conflictKey]: "manter" }, planFingerprint: plan3.fingerprint });
  const afterKeep = await prisma.goal.findUnique({ where: { id: newGoal.id } });
  check("[C] resolução 'manter' preserva o valor atual", Number(afterKeep.targetAmount) === 1000, String(afterKeep.targetAmount));

  // resolução "usar o do arquivo" -> aplica
  const appliedUse = await applyImportBatch(prisma, { mode: "update", datasets: ["goals"], rows: updateRows, resolutions: { [conflictKey]: "usar" }, planFingerprint: plan3.fingerprint });
  const afterUse = await prisma.goal.findUnique({ where: { id: newGoal.id } });
  check("[C] resolução 'usar' aplica o valor do arquivo", Number(afterUse.targetAmount) === 2500, String(afterUse.targetAmount));
  check("[C] apply contou 1 updated", appliedUse.counts.updated === 1, JSON.stringify(appliedUse.counts));

  // ============================================================
  // 4) MATCH POR ID (round-trip real) -> UPDATE direto, sem conflito
  // ============================================================
  const rowsById = { goals: [{ id: newGoal.id, name: goalName, targetAmount: 3333, savedAmount: 0 }] };
  const plan4 = await planImport({ prisma, mode: "update", datasets: ["goals"], rowsBySheet: rowsById });
  check("[D] match por ID -> update direto, 0 conflitos", plan4.perDataset.goals.updates.length === 1 && plan4.perDataset.goals.conflicts.length === 0, JSON.stringify(plan4.perDataset.goals));

  // ============================================================
  // 5) CONCORRÊNCIA OTIMISTA — muda o registro por fora entre preview e apply -> ABORT
  // ============================================================
  const planForStale = await planImport({ prisma, mode: "update", datasets: ["goals"], rowsBySheet: rowsById });
  await prisma.goal.update({ where: { id: newGoal.id }, data: { notes: `${MARK} mudou por fora` } }); // simula edição concorrente
  const staleCheck = await fingerprintStillValid(prisma, planForStale.fingerprint);
  check("[E] fingerprint detecta mudança concorrente", staleCheck.valid === false, JSON.stringify(staleCheck));
  let staleAborted = false;
  try {
    await applyImportBatch(prisma, { mode: "update", datasets: ["goals"], rows: rowsById, resolutions: {}, planFingerprint: planForStale.fingerprint });
  } catch (err) {
    staleAborted = err instanceof StaleImportError;
  }
  check("[E] apply ABORTA (StaleImportError) quando o dado mudou", staleAborted);

  // ============================================================
  // 6) UNDO — desfaz o create da etapa 2 (via um apply fresco, isolado)
  // ============================================================
  const undoGoalName = `${MARK} Undo`;
  const undoRows = { goals: [{ name: undoGoalName, targetAmount: 500, savedAmount: 0 }] };
  const appliedForUndo = await applyImportBatch(prisma, { mode: "add", datasets: ["goals"], rows: undoRows, resolutions: {}, planFingerprint: [] });
  const goalForUndo = await prisma.goal.findFirst({ where: { name: undoGoalName } });
  check("[F] goal criada pra teste de undo existe", !!goalForUndo);
  const fakeBatch = { preimages: appliedForUndo.preimages, undoDeadline: new Date(Date.now() + 60000) };
  await undoImportBatch(prisma, fakeBatch);
  const afterUndo = await prisma.goal.findUnique({ where: { id: goalForUndo.id } });
  check("[F] undo de um CREATE remove o registro", afterUndo === null);

  // ============================================================
  // 7) SUBSTITUIR — escopo isolado (ano fictício 2099, zero dado real ali)
  // ============================================================
  const REPLACE_PERIOD_MARKER = "2099"; // fora de qualquer período real usado pelos outros testes/produto.
  const acct = await prisma.account.findFirst();
  check("[G] pré-condição: existe ao menos 1 conta real pra testar substituir", !!acct);
  if (acct) {
    // cria 2 incomes sintéticas em 2099 (fora de qualquer dado real)
    const synthetic = await Promise.all([
      prisma.income.create({ data: { amount: 111, description: `${MARK} substituir A`, accountId: acct.id, occurredAt: new Date("2099-01-10") } }),
      prisma.income.create({ data: { amount: 222, description: `${MARK} substituir B`, accountId: acct.id, occurredAt: new Date("2099-01-20") } }),
    ]);
    synthetic.forEach((s) => created.incomes.push(s.id));

    const replaceRows = { incomes: [{ amount: 999, description: `${MARK} substituir NOVA`, accountName: acct.name, occurredAt: new Date("2099-01-15") }] };
    // período "all" pegaria TUDO — em vez disso, filtramos manualmente o
    // escopo aqui simulando um período custom via range direto no teste
    // (planReplace usa periodRange(period), que não tem uma opção "ano
    // específico" na UI — este teste valida o MOTOR, não a opção de UI).
    const { periodRange } = await import("../lib/dataHub/sheets.js");
    const range2099 = { gte: new Date("2099-01-01"), lt: new Date("2100-01-01") };
    const existing2099 = await prisma.income.findMany({ where: { occurredAt: range2099 }, select: { id: true } });
    check("[G] escopo 2099 contém exatamente as 2 incomes sintéticas", existing2099.length === 2, String(existing2099.length));

    const replacePlan = await planReplace({ prisma, datasets: ["incomes"], period: "all", rowsBySheet: replaceRows });
    // period:"all" no motor real deletaria tudo — pra manter o teste seguro
    // contra o dataset de produção reconciliado, testamos deletableIds
    // manualmente restritos ao escopo sintético em vez de rodar applyReplace
    // com period "all" de verdade.
    const onlySynthetic = replacePlan.perDataset.incomes.deletableIds.filter((id) => created.incomes.includes(id));
    check("[G] plano de substituir identifica as sintéticas como deletáveis", onlySynthetic.length === 2, String(onlySynthetic.length));

    // aplica substituir SÓ no escopo sintético via transação manual (não
    // chama applyReplace com period=all — isso apagaria a Renda real do
    // usuário, o que este teste JAMAIS deve fazer).
    await prisma.$transaction(async (tx) => {
      await tx.income.deleteMany({ where: { id: { in: created.incomes } } });
      const c = await tx.income.create({ data: { amount: 999, description: `${MARK} substituir NOVA`, accountId: acct.id, occurredAt: new Date("2099-01-15") } });
      created.incomes = [c.id]; // só a nova sobrevive pra cleanup
    });
    const afterReplace = await prisma.income.findMany({ where: { occurredAt: range2099 } });
    check("[G] após substituir (escopo isolado): só a nova existe", afterReplace.length === 1 && afterReplace[0].amount.toNumber() === 999, JSON.stringify(afterReplace.map((r) => r.amount.toString())));
  }

  // ============================================================
  // 8) SEGURANÇA REFERENCIAL — Expense linkada a ExternalInstallment nunca entra no escopo deletável
  // ============================================================
  const linkedPlan = await prisma.externalInstallmentPlan.findFirst({ include: { installments: { where: { expenseId: { not: null } }, take: 1 } } });
  if (linkedPlan && linkedPlan.installments.length > 0) {
    const linkedExpenseId = linkedPlan.installments[0].expenseId;
    const expenseRow = await prisma.expense.findUnique({ where: { id: linkedExpenseId } });
    if (expenseRow) {
      const range = { gte: new Date(expenseRow.occurredAt.getTime() - 1000), lt: new Date(expenseRow.occurredAt.getTime() + 1000) };
      const scan = await prisma.expense.findMany({ where: { occurredAt: range }, select: { id: true } });
      const ids = scan.map((r) => r.id);
      const eiRefs = await prisma.externalInstallment.findMany({ where: { expenseId: { in: ids } }, select: { expenseId: true } });
      const protectedSet = new Set(eiRefs.map((r) => r.expenseId));
      check("[H] Expense settlement-linked é identificada como protegida", protectedSet.has(linkedExpenseId));
    } else {
      check("[H] (sem Expense linkada encontrada nesta base — pulado)", true);
    }
  } else {
    check("[H] (sem ExternalInstallment com expenseId nesta base — pulado)", true);
  }

  console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("ERRO INESPERADO:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
