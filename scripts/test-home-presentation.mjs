// Fase 5.4C, item 60 — testes de PRESENTATION-DERIVATION da Home (não JSX
// snapshot, comportamento): motivo dominante, copy de status, legenda de
// freeMoney negativo, banner crítico, e os 4 estados de status com fixtures
// sintéticas. Puro — nenhum acesso a banco, nenhuma escrita. Fixtures 100%
// fictícias (nomes/valores genéricos, nenhum dado pessoal real).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  selectDominantReason,
  STATUS_COPY,
  freeMoneyLegend,
  selectCriticalBannerReason,
  shouldSuggestSimulation,
  obligationItemLabel,
  obligationItemDate,
  obligationItemHref,
} from "../lib/homePresentation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;
function check(condition, label, extra = "") {
  if (condition) {
    passed++;
    console.log(`✅ ${label}${extra ? ` (${extra})` : ""}`);
  } else {
    failed++;
    console.error(`❌ ${label}${extra ? ` (${extra})` : ""}`);
  }
}

console.log("--- Fase 5.4C: Home Presentation ---\n");

// ==========================================================================
// 1) Motivo dominante — item 11: maior valor absoluto, nunca o primeiro da
//    lista por acaso.
// ==========================================================================
{
  const breakdown = [
    { type: "CardBill", cardName: "Cartão Teste", cycleMonth: "2099-01", amount: 120, class: "INCURRED_LIABILITY" },
    { type: "ConfirmedCommitment", description: "Fixture A", amount: 500, class: "CURRENT_HORIZON_OBLIGATION" },
  ];
  const dominant = selectDominantReason(breakdown);
  check(dominant.amount === 500, "motivo dominante = maior valor absoluto (500 > 120), não o primeiro da lista", `escolhido: ${dominant.description}`);
}
{
  // Ordem invertida — prova que não é "sempre o primeiro item".
  const breakdown = [
    { type: "ConfirmedCommitment", description: "Fixture B", amount: 100, class: "CURRENT_HORIZON_OBLIGATION" },
    { type: "CardBill", cardName: "Cartão Teste", cycleMonth: "2099-01", amount: 900, class: "INCURRED_LIABILITY" },
  ];
  const dominant = selectDominantReason(breakdown);
  check(dominant.amount === 900, "motivo dominante independe de ordem de entrada", `escolhido: ${dominant.type}`);
}
check(selectDominantReason([]) === null, "breakdown vazio -> motivo dominante = null (nunca inventa item)");
check(selectDominantReason(null) === null, "breakdown null -> motivo dominante = null (nunca lança)");

// ==========================================================================
// 2) Status copy — item 7: 4 estados, sempre factual, nunca julgador.
// ==========================================================================
for (const status of ["TRANQUILO", "ATENCAO", "APERTADO", "CRITICO"]) {
  const copy = STATUS_COPY[status];
  check(copy != null, `STATUS_COPY define ${status}`);
  check(!/\b(voce|você)\b/i.test(copy.headline), `${status}: headline nunca se dirige à pessoa em 2ª pessoa (não julga caráter)`, copy.headline);
}
check(STATUS_COPY.APERTADO.headline.toLowerCase().includes("compromisso"), "APERTADO descreve timing (compromisso vs dinheiro livre), não caráter");

// ==========================================================================
// 3) FreeMoney legend — item 8: negativo sempre tem legenda; positivo nunca.
//    Valores fictícios (nenhum coincide com dado real do produto).
// ==========================================================================
check(freeMoneyLegend(-50) === "além do que está livre hoje", "freeMoney negativo tem legenda");
check(freeMoneyLegend(500) === null, "freeMoney positivo NÃO tem legenda (nada a explicar)");
check(freeMoneyLegend(0) === null, "freeMoney exatamente zero NÃO tem legenda 'além de'");

// ==========================================================================
// 4) shouldSuggestSimulation — item 32: só Apertado/Crítico.
// ==========================================================================
check(!shouldSuggestSimulation("TRANQUILO"), "Tranquilo nunca sugere simular");
check(!shouldSuggestSimulation("ATENCAO"), "Atenção nunca sugere simular");
check(shouldSuggestSimulation("APERTADO"), "Apertado sugere simular");
check(shouldSuggestSimulation("CRITICO"), "Crítico sugere simular");

// ==========================================================================
// 5) Banner crítico — item 24: só existe com o motivo estruturado REAL
//    (nunca uma frase inventada quando o reason não está presente).
// ==========================================================================
{
  const reasons = [
    { code: "FREE_MONEY_NEGATIVE", message: "..." },
    { code: "BASE_CASH_NEGATIVE_BEFORE_INCOME", message: "O caixa físico projetado fica negativo antes da renda." },
  ];
  const found = selectCriticalBannerReason(reasons);
  check(found?.code === "BASE_CASH_NEGATIVE_BEFORE_INCOME", "banner crítico usa a MESMA mensagem estruturada de lib/financialStatus.js");
}
check(selectCriticalBannerReason([{ code: "EXPECTED_INCOME_OVERDUE" }]) === null, "sem o reason BASE_CASH_NEGATIVE_BEFORE_INCOME -> nenhum banner (nunca inventa)");
check(selectCriticalBannerReason(null) === null, "statusReasons null -> nenhum banner (nunca lança)");
check(selectCriticalBannerReason([]) === null, "statusReasons vazio -> nenhum banner");

// ==========================================================================
// 6) Item 13 — breakdown item label/date/href.
// ==========================================================================
{
  const cardItem = { type: "CardBill", cardName: "Cartão Teste", cycleMonth: "2099-01", dueAt: new Date("2099-01-11") };
  check(obligationItemLabel(cardItem) === "Fatura Cartão Teste (2099-01)", "CardBill label humana (nunca 'CardBill' cru)");
  check(obligationItemDate(cardItem)?.getTime() === new Date("2099-01-11").getTime(), "CardBill usa dueAt");
  check(obligationItemHref(cardItem) === "/cartoes", "CardBill tem destino real (/cartoes já existe hoje)");
}
{
  const commitmentItem = { type: "ConfirmedCommitment", description: "Fixture C", dueDate: new Date("2099-01-20") };
  check(obligationItemLabel(commitmentItem) === "Fixture C", "ConfirmedCommitment usa description");
  check(obligationItemHref(commitmentItem) === null, "item 13: SEM destino real hoje -> href null (nunca link fake pra /compromissos, que não existe até 5.4D)");
}

// ==========================================================================
// 7) NO_NEW_V1_CONSUMERS (item 3) — nenhum arquivo NOVO/reescrito desta Home
//    importa lib/indicators.js, lib/intelligence.js, lib/alerts.js ou
//    lib/cashFlowProjection.js. ONE_TRUTH_ONE_NAME (item 48) — nenhum deles
//    reintroduz o vocabulário V1 ("Caixa livre"/"Patrimônio disponível").
//
// Fase 6.0 (Design Freeze) — a Home foi revestida sobre a identidade final
// do ZIP aprovado (hero "Dá para gastar hoje" + bridge chart + tiras/cards
// novos); a MESMA hierarquia de decisão da 5.4C continua valendo (ver
// comentário no topo de Dashboard.jsx), só a composição de arquivos mudou.
// Lista atualizada pros componentes atuais — FinancialHero/NextIncomeCard/
// PhysicalMoneyContext/SpendingSection/ProjectionSummary foram REMOVIDOS
// (superseded), não sobrevivem como arquivo nem como import.
// ==========================================================================
const NEW_HOME_FILES = [
  "lib/homePresentation.js",
  "app/components/Dashboard.jsx",
  "app/components/dashboard/SpendableTodayCard.jsx",
  "app/components/dashboard/MoneyBridgeCard.jsx",
  "app/components/dashboard/NotSpendableStrip.jsx",
  "app/components/dashboard/WeightedPressuresCard.jsx",
  "app/components/dashboard/NextIncomeSpotlight.jsx",
  "app/components/dashboard/UpcomingEventsCard.jsx",
  "app/components/dashboard/RiskSurface.jsx",
  "app/components/ui/Disclosure.jsx",
];
const REMOVED_HOME_FILES = [
  "app/components/dashboard/FinancialHero.jsx",
  "app/components/dashboard/NextIncomeCard.jsx",
  "app/components/dashboard/PhysicalMoneyContext.jsx",
  "app/components/dashboard/SpendingSection.jsx",
  "app/components/dashboard/ProjectionSummary.jsx",
];
for (const relPath of REMOVED_HOME_FILES) {
  check(!fs.existsSync(path.join(ROOT, relPath)), `SUPERSEDED_FILE_GONE: ${relPath} não existe mais (substituído na Fase 6.0)`);
}
const V1_IMPORT_RE = /lib\/(indicators|intelligence|alerts|cashFlowProjection)(\.js)?["']/;
// Remove comentários (// linha, /* bloco */, {/* JSX */}) antes de checar
// vocabulário — o código legitimamente CITA "Caixa livre"/"Patrimônio
// disponível" em comentários explicando por que NÃO usar esses nomes (ver
// PhysicalMoneyContext.jsx); só copy renderizada de verdade importa aqui.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
for (const relPath of NEW_HOME_FILES) {
  const content = fs.readFileSync(path.join(ROOT, relPath), "utf8");
  const code = stripComments(content);
  check(!V1_IMPORT_RE.test(content), `NO_NEW_V1_CONSUMERS: ${relPath} não importa nenhuma lib V1`);
  check(!code.includes("Patrimônio disponível") && !code.includes("Caixa livre"), `ONE_TRUTH_ONE_NAME: ${relPath} não usa vocabulário V1 fora de comentários`);
}

console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
if (failed > 0) process.exit(1);
