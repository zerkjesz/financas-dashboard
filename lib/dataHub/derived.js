import { buildProductFinancialSnapshot } from "../productFinancialSnapshot.js";
import { buildBaseProjection } from "../financialProjection.js";
import { serializeMoney, money } from "../money.js";
import RAW_SHEETS from "./sheets.js";

// ============================================================================
// Fase 6.0 (Design Freeze) — SHEETS DERIVADAS. Cada uma chama o MESMO
// builder canônico que o resto do produto usa (buildProductFinancialSnapshot/
// buildBaseProjection) — nunca uma segunda fórmula (item 11/63 do pedido:
// "não reimplementar financial engine"). Toda linha carrega `asOf` +
// `fonte`, deixando explícito que é CALCULADO, nunca um registro de origem.
// ============================================================================

function m(v) {
  return v == null ? null : serializeMoney(money(v));
}

const INDICADORES_SHEET = {
  key: "indicadores",
  sheetName: "Indicadores",
  description: "indicadores calculados no momento da exportação",
  importable: false,
  columns: [
    { key: "indicador", header: "Indicador", type: "string" },
    { key: "valor", header: "Valor", type: "money" },
    { key: "fonte", header: "Fonte (lib)", type: "string" },
  ],
  async fetch() {
    const asOf = new Date();
    const s = await buildProductFinancialSnapshot({ now: asOf });
    const rows = [
      ["Dinheiro livre desprotegido (unrestrictedCash)", s.liquidity.unrestrictedCash, "lib/freeMoney.js"],
      ["Dinheiro livre (freeMoney)", s.liquidity.freeMoney, "lib/freeMoney.js"],
      ["Seguro pra gastar hoje (safeToSpend)", s.liquidity.safeToSpend, "lib/freeMoney.js"],
      ["Margem de segurança (%)", s.liquidity.safetyMarginPercent, "lib/settings.js"],
      ["Dinheiro protegido (protectedMoney)", s.liquidity.protectedMoney, "lib/freeMoney.js"],
      ["Já gasto / incorrido (incurredLiabilities)", s.currentObligations.incurredLiabilities, "lib/freeMoney.js"],
      ["Vence antes da próxima renda (dueBeforeNextIncome)", s.currentObligations.dueBeforeNextIncome, "lib/freeMoney.js"],
      ["Próxima renda — valor-base", s.nextIncome?.baseAmount ?? null, "lib/incomeHorizon.js"],
      ["Já comprometido da próxima renda", s.nextIncomeCommitment?.committedAmount ?? null, "lib/freeMoney.js"],
      ["Saldo do vale-alimentação (restrito)", s.restricted?.vaBalance ?? null, "lib/vaPanel.js"],
    ];
    return rows.map(([indicador, valor, fonte]) => ({ indicador, valor: valor == null ? null : m(valor), fonte }));
  },
  async fetchStatus() {
    const s = await buildProductFinancialSnapshot({ now: new Date() });
    return s.liquidity.status;
  },
};

const PROJECAO_SHEET = {
  key: "projecao",
  sheetName: "Projeções",
  description: "um registro por evento futuro conhecido (base, sem cenário de risco)",
  importable: false,
  columns: [
    { key: "date", header: "Data", type: "date" },
    { key: "diasAPartirDeHoje", header: "Dias a partir de hoje", type: "int" },
    { key: "label", header: "Evento", type: "string" },
    { key: "kind", header: "Tipo", type: "string" },
    { key: "amount", header: "Valor", type: "money" },
    { key: "balanceAfter", header: "Saldo projetado depois", type: "money" },
  ],
  async fetch() {
    const now = new Date();
    const base = await buildBaseProjection({ horizonDays: 90, now });
    return base.timeline.map((e) => ({
      date: e.date,
      diasAPartirDeHoje: Math.round((new Date(e.date) - now) / 86400000),
      label: e.label,
      kind: e.kind,
      amount: m(e.amount),
      balanceAfter: m(e.balanceAfter),
    }));
  },
};

// "Resumo" — 1 linha, manifesto do momento da exportação. Contagens reais
// (nunca hardcoded) via os próprios fetchers do catálogo RAW.
async function buildResumoRows({ period }) {
  const counts = {};
  for (const sheet of RAW_SHEETS) {
    const rows = await sheet.fetch({ period });
    counts[sheet.sheetName] = rows.length;
  }
  const status = await INDICADORES_SHEET.fetchStatus();
  return {
    counts,
    row: {
      geradoEm: new Date(),
      situacaoFinanceira: status,
      totalSheets: RAW_SHEETS.length + 3, // + Indicadores/Projeções/Dicionário
      totalLinhas: Object.values(counts).reduce((a, b) => a + b, 0),
    },
  };
}

export { INDICADORES_SHEET, PROJECAO_SHEET, buildResumoRows };
