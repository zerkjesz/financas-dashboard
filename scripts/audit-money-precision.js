// ============================================================================
// scripts/audit-money-precision.js — READ-ONLY, do início ao fim.
//
// Mesma regra de scripts/audit.js: ZERO create/update/delete/upsert/raw SQL
// mutante. Só find/aggregate/count. Este script é diagnóstico pré-migration
// (Fase 3.0) — compara o valor Float armazenado hoje contra o que um
// ROUND(valor, 2) produziria, SEM gravar nada, pra decidir com dado real (não
// suposição) se a migration Float -> Decimal(12,2) precisa de limpeza de ruído.
//
// IMPORTANTE (limitação honesta): o "round2" aqui é feito em JS
// (Math.round(v*100)/100), que tem sua própria imprecisão de ponto flutuante —
// isso é aceitável pra um script de RECONHECIMENTO (identificar candidatos),
// mas não é a autoridade final. Na migration de verdade, quem decide o valor
// gravado é o `ROUND(coluna::numeric, 2)` do PRÓPRIO Postgres (aritmética
// decimal exata) — este script só aponta onde prestar atenção.
// ============================================================================
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Todo campo Float do schema que representa dinheiro (ver inventário no relatório).
const FIELDS = [
  { accessor: "card", field: "totalLimit", label: "Card.totalLimit", nullable: false },
  { accessor: "income", field: "amount", label: "Income.amount", nullable: false },
  { accessor: "expense", field: "amount", label: "Expense.amount", nullable: false },
  { accessor: "transfer", field: "amount", label: "Transfer.amount", nullable: false },
  { accessor: "balanceAdjustment", field: "newBalance", label: "BalanceAdjustment.newBalance", nullable: false },
  { accessor: "cardLimitUpdate", field: "newTotalLimit", label: "CardLimitUpdate.newTotalLimit", nullable: true },
  { accessor: "cardLimitUpdate", field: "newUsedLimit", label: "CardLimitUpdate.newUsedLimit", nullable: false },
  { accessor: "cardLimitUpdate", field: "reportedAvailable", label: "CardLimitUpdate.reportedAvailable", nullable: true },
  { accessor: "purchase", field: "totalAmount", label: "Purchase.totalAmount", nullable: false },
  { accessor: "purchase", field: "installmentValue", label: "Purchase.installmentValue", nullable: false },
  { accessor: "installment", field: "amount", label: "Installment.amount", nullable: false },
  { accessor: "cardBill", field: "totalAmount", label: "CardBill.totalAmount", nullable: false },
  { accessor: "cardBill", field: "paidAmount", label: "CardBill.paidAmount", nullable: true },
  { accessor: "recurringRule", field: "amount", label: "RecurringRule.amount", nullable: true },
  { accessor: "bill", field: "amount", label: "Bill.amount", nullable: false },
  { accessor: "goal", field: "targetAmount", label: "Goal.targetAmount", nullable: false },
  { accessor: "goal", field: "savedAmount", label: "Goal.savedAmount", nullable: false },
];

// Epsilon pra separar "ruído de ponto flutuante" (~1e-13 a 1e-15 tipicamente)
// de "diferença real de 3ª casa decimal em diante" (>= 0.001). 1e-6 é uma
// margem confortável entre as duas escalas.
const EPSILON = 1e-6;
function round2(v) {
  return Math.round(v * 100) / 100;
}

async function auditField({ accessor, field, label, nullable }) {
  const totalRows = await prisma[accessor].count();
  const rows = await prisma[accessor].findMany({ select: { id: true, [field]: true } });
  const values = rows.filter((r) => r[field] != null).map((r) => ({ id: r.id, value: r[field] }));

  if (values.length === 0) {
    return {
      label, nullable, totalRows, nonNullCount: 0,
      min: null, max: null, negativeCount: 0, moreThanTwoDecimalsCount: 0,
      wouldChangeCount: 0, maxAbsDiff: 0, sumBefore: 0, sumAfter: 0, diffTotal: 0, examples: [],
    };
  }

  let min = Infinity, max = -Infinity, negativeCount = 0, moreThanTwoDecimalsCount = 0;
  let sumBefore = 0, sumAfter = 0;
  const diffs = [];

  for (const { id, value } of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    if (value < 0) negativeCount++;
    const rounded = round2(value);
    const diff = value - rounded;
    if (Math.abs(diff) > EPSILON) {
      moreThanTwoDecimalsCount++;
      diffs.push({ id, before: value, after: rounded, diff });
    }
    sumBefore += value;
    sumAfter += rounded;
  }

  diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  return {
    label, nullable, totalRows, nonNullCount: values.length,
    min, max, negativeCount, moreThanTwoDecimalsCount,
    wouldChangeCount: diffs.length,
    maxAbsDiff: diffs.length > 0 ? Math.abs(diffs[0].diff) : 0,
    sumBefore, sumAfter, diffTotal: sumBefore - sumAfter,
    examples: diffs.slice(0, 5),
  };
}

function fmt(n) {
  return n == null ? "—" : n.toFixed(6);
}

async function main() {
  console.log("--- Auditoria de precisão monetária (Float -> ROUND(2)), read-only ---\n");

  let anyWouldChange = false;
  const results = [];

  for (const spec of FIELDS) {
    const r = await auditField(spec);
    results.push(r);

    console.log(`## ${r.label}${r.nullable ? " (nullable)" : ""}`);
    console.log(`   linhas no model: ${r.totalRows} | valores não-nulos neste campo: ${r.nonNullCount}`);
    if (r.nonNullCount === 0) {
      console.log("   (sem dado nesta tabela/campo)\n");
      continue;
    }
    console.log(`   min: R$ ${fmt(r.min)} | max: R$ ${fmt(r.max)} | negativos: ${r.negativeCount}`);
    console.log(`   valores com mais de 2 casas decimais reais: ${r.moreThanTwoDecimalsCount}`);
    console.log(`   registros que mudariam com ROUND(2): ${r.wouldChangeCount}`);
    if (r.wouldChangeCount === 0) {
      console.log("   ✅ já são exatamente 2 casas em todos os registros — ROUND(2) não muda nada aqui.");
    } else {
      anyWouldChange = true;
      console.log(`   maior diferença absoluta: ${r.maxAbsDiff.toFixed(10)}`);
      console.log(`   soma antes: R$ ${fmt(r.sumBefore)} | soma depois do ROUND(2): R$ ${fmt(r.sumAfter)} | diferença total: R$ ${fmt(r.diffTotal)}`);
      console.log("   exemplos (maior diferença primeiro):");
      for (const ex of r.examples) {
        console.log(`     id=${ex.id} | antes=${ex.before} | depois=${ex.after} | diff=${ex.diff}`);
      }
    }
    console.log("");
  }

  console.log("--- Resumo ---");
  console.log(
    anyWouldChange
      ? "⚠️  Existem campos onde ROUND(2) mudaria algum valor — ver detalhes acima antes de aprovar a migration."
      : "✅ Todos os campos monetários já têm exatamente 2 casas decimais em 100% dos registros — ROUND(2) não alteraria nenhum valor."
  );

  // Nada é escrito — script termina aqui, só leitura do início ao fim.
}

main().finally(() => prisma.$disconnect());
