// Fase 6.0.1 (Data Hub Integrity Closure, item 16) — matriz de validação do
// parser/matcher que ainda não tinha teste dedicado: versão de schema
// desconhecida, colunas faltando, aba desconhecida, limites de tamanho
// (arquivo/linhas/abas), dinheiro/data inválidos, confiança inválida no
// arquivo (nunca confia cegamente), duplicata dentro do MESMO arquivo (nunca
// deduplicada silenciosamente pra ledger — regra de negócio, não bug), e
// match ambíguo (2+ candidatos -> nunca escolhe sozinho).
//
// Puro — sem HTTP, sem servidor. node scripts/test-data-hub-validation.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import ExcelJS from "exceljs";
import { prisma } from "../lib/prisma.js";
import { parseImportFile, ImportParseError, MAX_FILE_SIZE_BYTES, MAX_ROWS_PER_SHEET, MAX_SHEETS } from "../lib/dataHub/parse.js";
import { planImport } from "../lib/dataHub/plan.js";

const MARK = "TESTE_DATAHUB_VALIDATION";
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

const created = { goals: [] };
async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const id of created.goals) await prisma.goal.delete({ where: { id } }).catch(() => {});
  const stray = await prisma.goal.findMany({ where: { name: { contains: MARK } } });
  for (const g of stray) await prisma.goal.delete({ where: { id: g.id } }).catch(() => {});
  console.log(`Limpeza: goals remanescentes=${stray.length}.`);
}

function receitasSheet(wb, rows) {
  const ws = wb.addWorksheet("Receitas");
  ws.addRow(["ID", "Valor", "Descrição", "Categoria", "Conta", "Recorrente", "Origem", "Confiança", "Data", "Criado em"]);
  for (const r of rows) ws.addRow(r);
  return ws;
}

async function main() {
  // ==========================================================================
  // 1) VERSÃO DE SCHEMA DESCONHECIDA — não trava a importação, só sinaliza.
  // ==========================================================================
  {
    const wb = new ExcelJS.Workbook();
    const resumo = wb.addWorksheet("Resumo");
    resumo.addRow(["schemaVersion", "periodo", "timezone"]);
    resumo.addRow(["99.9.9-desconhecida", "todo", "America/Sao_Paulo"]);
    receitasSheet(wb, [[null, 10, `${MARK} versao`, "Outros", "Itaú", false, null, null, new Date("2099-01-01"), null]]);
    const buf = await wb.xlsx.writeBuffer();
    const parsed = await parseImportFile(Buffer.from(buf), { fileName: "teste.xlsx" });
    check("[1] versão desconhecida detectada", parsed.detectedSchemaVersion === "99.9.9-desconhecida", parsed.detectedSchemaVersion);
    check("[1] schemaVersionKnown=false (mas NÃO lança erro — segue processando)", parsed.schemaVersionKnown === false);
    check("[1] linhas continuam sendo lidas mesmo com versão desconhecida", parsed.rowsBySheet.incomes?.length === 1);
  }

  // ==========================================================================
  // 2) COLUNAS FALTANDO — reportado por aba, nunca silenciosamente ignorado.
  // ==========================================================================
  {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Receitas");
    ws.addRow(["ID", "Valor", "Descrição"]); // faltam Categoria/Conta/Recorrente/Origem/Confiança/Data/Criado em
    ws.addRow([null, 10, `${MARK} colunas faltando`]);
    const buf = await wb.xlsx.writeBuffer();
    const parsed = await parseImportFile(Buffer.from(buf), { fileName: "teste.xlsx" });
    const report = parsed.sheetReports.find((r) => r.key === "incomes");
    check("[2] missingColumns reporta as colunas ausentes", report.missingColumns.includes("Categoria") && report.missingColumns.includes("Conta"), JSON.stringify(report.missingColumns));
  }

  // ==========================================================================
  // 3) ABA DESCONHECIDA — nunca processada como se fosse um dataset real.
  // ==========================================================================
  {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Aba Que Não Existe No Catálogo");
    receitasSheet(wb, [[null, 10, `${MARK} aba desconhecida`, "Outros", "Itaú", false, null, null, new Date("2099-01-01"), null]]);
    const buf = await wb.xlsx.writeBuffer();
    const parsed = await parseImportFile(Buffer.from(buf), { fileName: "teste.xlsx" });
    check("[3] aba fora do catálogo aparece em unknownSheets", parsed.unknownSheets.includes("Aba Que Não Existe No Catálogo"), JSON.stringify(parsed.unknownSheets));
  }

  // ==========================================================================
  // 4) OVERSIZE — arquivo grande, linhas demais, abas demais.
  // ==========================================================================
  {
    const bigBuffer = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1024);
    let threw = null;
    try {
      await parseImportFile(bigBuffer, { fileName: "grande.xlsx" });
    } catch (err) {
      threw = err;
    }
    check("[4] arquivo maior que 15MB -> ImportParseError FILE_TOO_LARGE", threw instanceof ImportParseError && threw.code === "FILE_TOO_LARGE", threw?.code);
  }
  {
    const wb = new ExcelJS.Workbook();
    for (let i = 0; i < MAX_SHEETS + 1; i++) wb.addWorksheet(`Extra ${i}`);
    const buf = await wb.xlsx.writeBuffer();
    let threw = null;
    try {
      await parseImportFile(Buffer.from(buf), { fileName: "muitas-abas.xlsx" });
    } catch (err) {
      threw = err;
    }
    check(`[4] arquivo com mais de ${MAX_SHEETS} abas -> ImportParseError TOO_MANY_SHEETS`, threw instanceof ImportParseError && threw.code === "TOO_MANY_SHEETS", threw?.code);
  }
  {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Receitas");
    ws.addRow(["ID", "Valor", "Descrição", "Categoria", "Conta", "Recorrente", "Origem", "Confiança", "Data", "Criado em"]);
    for (let i = 0; i < MAX_ROWS_PER_SHEET + 1; i++) ws.addRow([null, 1, `${MARK} linha ${i}`, "Outros", "Itaú", false, null, null, new Date("2099-01-01"), null]);
    const buf = await wb.xlsx.writeBuffer();
    let threw = null;
    try {
      await parseImportFile(Buffer.from(buf), { fileName: "muitas-linhas.xlsx" });
    } catch (err) {
      threw = err;
    }
    check(`[4] aba com mais de ${MAX_ROWS_PER_SHEET} linhas -> ImportParseError TOO_MANY_ROWS`, threw instanceof ImportParseError && threw.code === "TOO_MANY_ROWS", threw?.code);
  }
  {
    let threw = null;
    try {
      await parseImportFile(Buffer.from("não é um xlsx de verdade"), { fileName: "malformado.xlsx" });
    } catch (err) {
      threw = err;
    }
    check("[4] arquivo malformado (não é um zip/xlsx real) -> ImportParseError MALFORMED_FILE", threw instanceof ImportParseError && threw.code === "MALFORMED_FILE", threw?.code);
  }
  {
    let threw = null;
    try {
      await parseImportFile(Buffer.from("qualquer coisa"), { fileName: "arquivo.csv" });
    } catch (err) {
      threw = err;
    }
    check("[4] extensão não-.xlsx (ex: .csv) -> ImportParseError UNSUPPORTED_FORMAT (CSV não existe nesta fase)", threw instanceof ImportParseError && threw.code === "UNSUPPORTED_FORMAT", threw?.code);
  }

  // ==========================================================================
  // 5) DINHEIRO INVÁLIDO — nunca cria com valor ausente/não-numérico; vira INVALID.
  // ==========================================================================
  {
    const acct = await prisma.account.findFirst();
    const rowsBySheet = { incomes: [{ amount: null, description: `${MARK} dinheiro invalido`, accountName: acct?.name, occurredAt: new Date("2099-01-01") }] };
    const plan = await planImport({ prisma, mode: "add", datasets: ["incomes"], rowsBySheet });
    check("[5] amount ausente -> linha INVALID, nunca cria", plan.perDataset.incomes.creates.length === 0 && plan.perDataset.incomes.invalid.length === 1, JSON.stringify(plan.perDataset.incomes.invalid));
  }
  {
    const acct = await prisma.account.findFirst();
    const rowsBySheet = { incomes: [{ amount: "não é um número", description: `${MARK} dinheiro texto`, accountName: acct?.name, occurredAt: new Date("2099-01-01") }] };
    const plan = await planImport({ prisma, mode: "add", datasets: ["incomes"], rowsBySheet });
    check("[5] amount não-numérico -> linha INVALID, nunca cria", plan.perDataset.incomes.creates.length === 0 && plan.perDataset.incomes.invalid.length === 1, JSON.stringify(plan.perDataset.incomes.invalid));
  }

  // ==========================================================================
  // 6) DATA INVÁLIDA — nunca cria com data ilegível; vira INVALID.
  // ==========================================================================
  {
    const acct = await prisma.account.findFirst();
    const rowsBySheet = { incomes: [{ amount: 10, description: `${MARK} data invalida`, accountName: acct?.name, occurredAt: "não é uma data" }] };
    const plan = await planImport({ prisma, mode: "add", datasets: ["incomes"], rowsBySheet });
    check("[6] occurredAt ilegível -> linha INVALID, nunca cria", plan.perDataset.incomes.creates.length === 0 && plan.perDataset.incomes.invalid.length === 1, JSON.stringify(plan.perDataset.incomes.invalid));
  }

  // ==========================================================================
  // 7) CONFIANÇA INVÁLIDA NO ARQUIVO — nunca confia cegamente; cai pro
  //    fallback conservador (source="import", confidence="ESTIMATED").
  // ==========================================================================
  {
    const acct = await prisma.account.findFirst();
    if (acct) {
      const rowsBySheet = { incomes: [{ amount: 10, description: `${MARK} confianca invalida`, accountName: acct.name, occurredAt: new Date("2099-01-01"), source: "um-valor-que-nao-existe-no-enum", confidence: "TOTALMENTE_INVENTADO" }] };
      const plan = await planImport({ prisma, mode: "add", datasets: ["incomes"], rowsBySheet });
      const data = plan.perDataset.incomes.creates[0]?.data;
      check("[7] source/confidence inválidos no arquivo -> fallback source=import", data?.source === "import", data?.source);
      check("[7] source/confidence inválidos no arquivo -> fallback confidence=ESTIMATED (nunca CONFIRMED sem critério)", data?.confidence === "ESTIMATED", data?.confidence);
    }
  }

  // ==========================================================================
  // 8) DUPLICATA DENTRO DO MESMO ARQUIVO — ledger NUNCA deduplica (2 compras
  //    iguais no mesmo dia são legítimas); as 2 linhas viram 2 creates.
  // ==========================================================================
  {
    const acct = await prisma.account.findFirst();
    if (acct) {
      const row = { amount: 42, description: `${MARK} duplicata`, accountName: acct.name, occurredAt: new Date("2099-01-01") };
      const rowsBySheet = { incomes: [{ ...row }, { ...row }] };
      const plan = await planImport({ prisma, mode: "add", datasets: ["incomes"], rowsBySheet });
      check("[8] 2 linhas idênticas no mesmo arquivo -> 2 creates (ledger não deduplica por design)", plan.perDataset.incomes.creates.length === 2, String(plan.perDataset.incomes.creates.length));
    }
  }

  // ==========================================================================
  // 9) MATCH AMBÍGUO — 2+ candidatos pra mesma chave natural -> NUNCA escolhe
  //    sozinho, vira INVALID pedindo ID.
  // ==========================================================================
  {
    const ambiguousName = `${MARK} Ambigua`;
    const g1 = await prisma.goal.create({ data: { name: ambiguousName, targetAmount: 100, savedAmount: 0 } });
    const g2 = await prisma.goal.create({ data: { name: ambiguousName, targetAmount: 200, savedAmount: 0 } });
    created.goals.push(g1.id, g2.id);
    const rowsBySheet = { goals: [{ name: ambiguousName, targetAmount: 999, savedAmount: 0 }] };
    const plan = await planImport({ prisma, mode: "update", datasets: ["goals"], rowsBySheet });
    const invalid = plan.perDataset.goals.invalid[0];
    check("[9] 2 Goals com o mesmo nome -> match AMBÍGUO, nunca escolhe um dos dois", plan.perDataset.goals.updates.length === 0 && plan.perDataset.goals.conflicts.length === 0 && plan.perDataset.goals.invalid.length === 1, JSON.stringify(plan.perDataset.goals));
    check("[9] motivo do INVALID pede desambiguação por ID", /ambígua/i.test(invalid?.reason || ""), invalid?.reason);
    check("[9] candidateIds lista os 2 IDs reais pro usuário escolher", invalid?.candidateIds?.length === 2, JSON.stringify(invalid?.candidateIds));
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
