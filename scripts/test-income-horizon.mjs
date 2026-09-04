// Fase 4.0.1, item 9 — testes puros (sem banco) de lib/incomeHorizon.js. Mesmo
// estilo de scripts/test-money.mjs/test-financial-cycle.mjs. Nenhum dado real do
// usuário — tudo sintético.
import { resolveNextExpectedIncome, INCOME_HORIZON_STATUS } from "../lib/incomeHorizon.js";

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
function iso(d) {
  return d.toISOString().slice(0, 10);
}
function d(s) {
  return new Date(`${s}T00:00:00.000Z`);
}

console.log("--- Testes puros: lib/incomeHorizon.js ---\n");

const SETTINGS = { cycleStartDay: 24 };
const CHECKING_ACCOUNT = { id: "acc-checking", type: "checking" };
const VA_ACCOUNT = { id: "acc-va", type: "food_voucher" };
const ACCOUNTS = [CHECKING_ACCOUNT, VA_ACCOUNT];
const SALARY_RULE = { id: "rule-salary", kind: "income", isActive: true, dayOfMonth: 24, accountId: CHECKING_ACCOUNT.id };
const VA_RULE = { id: "rule-va", kind: "income", isActive: true, dayOfMonth: 21, accountId: VA_ACCOUNT.id };

// ---- Caso A: 04/09 -> salário de 24/09 upcoming ----
{
  const result = resolveNextExpectedIncome({ now: d("2026-09-04"), recurringRules: [SALARY_RULE], accounts: ACCOUNTS, settings: SETTINGS });
  check(
    "04/09 → salário esperado 24/09, status UPCOMING",
    iso(result.expectedDate) === "2026-09-24" && result.status === INCOME_HORIZON_STATUS.UPCOMING,
    JSON.stringify({ ...result, expectedDate: iso(result.expectedDate) })
  );
}

// ---- Caso B: 24/09 sem Income -> due today ----
{
  const result = resolveNextExpectedIncome({ now: d("2026-09-24"), recurringRules: [SALARY_RULE], realizedIncomes: [], accounts: ACCOUNTS, settings: SETTINGS });
  check(
    "24/09 sem Income realizado → DUE_TODAY, data 24/09",
    iso(result.expectedDate) === "2026-09-24" && result.status === INCOME_HORIZON_STATUS.DUE_TODAY,
    JSON.stringify({ ...result, expectedDate: iso(result.expectedDate) })
  );
}

// ---- Caso C: 24/09 com Income realizado -> próxima 24/10 ----
{
  const result = resolveNextExpectedIncome({
    now: d("2026-09-24"),
    recurringRules: [SALARY_RULE],
    realizedIncomes: [{ recurringRuleId: SALARY_RULE.id, recurringOccurrenceDate: "2026-09-24" }],
    accounts: ACCOUNTS,
    settings: SETTINGS,
  });
  check(
    "24/09 com Income realizado → próxima ocorrência 24/10, UPCOMING",
    iso(result.expectedDate) === "2026-10-24" && result.status === INCOME_HORIZON_STATUS.UPCOMING,
    JSON.stringify({ ...result, expectedDate: iso(result.expectedDate) })
  );
}

// ---- Caso D: 25/09 sem Income de 24/09 -> overdue, não pula outubro ----
{
  const result = resolveNextExpectedIncome({ now: d("2026-09-25"), recurringRules: [SALARY_RULE], realizedIncomes: [], accounts: ACCOUNTS, settings: SETTINGS });
  check(
    "25/09 sem Income de 24/09 → OVERDUE, continua em 24/09 (NÃO pula pra outubro)",
    iso(result.expectedDate) === "2026-09-24" && result.status === INCOME_HORIZON_STATUS.OVERDUE,
    JSON.stringify({ ...result, expectedDate: iso(result.expectedDate) })
  );
}

// ---- Caso E: VA (dia 21) ignorado no income horizon ----
{
  // Só a regra de VA existe — nenhuma renda irrestrita elegível -> cai no fallback,
  // prova que o dia 21 da VA nunca é escolhido como nextExpectedIncome.
  const result = resolveNextExpectedIncome({ now: d("2026-09-04"), recurringRules: [VA_RULE], accounts: ACCOUNTS, settings: SETTINGS });
  check(
    "VA (food_voucher) é ignorada — cai no FALLBACK, nunca usa o dia 21 da VA",
    result.status === INCOME_HORIZON_STATUS.FALLBACK && result.isFallback === true && iso(result.expectedDate) !== "2026-09-21",
    JSON.stringify({ ...result, expectedDate: iso(result.expectedDate) })
  );
}
{
  // Com as duas regras (salário + VA) presentes, a VA continua fora da escolha —
  // o resultado tem que vir do salário (dia 24), nunca do dia 21.
  const result = resolveNextExpectedIncome({ now: d("2026-09-04"), recurringRules: [SALARY_RULE, VA_RULE], accounts: ACCOUNTS, settings: SETTINGS });
  check(
    "com salário + VA juntos, resultado vem do salário (24/09), VA nunca influencia",
    iso(result.expectedDate) === "2026-09-24" && result.recurringRuleId === SALARY_RULE.id,
    JSON.stringify({ ...result, expectedDate: iso(result.expectedDate) })
  );
}

// ---- Duas recurring incomes irrestritas -> escolhe a cronologicamente correta ----
{
  const secondJobRule = { id: "rule-bico", kind: "income", isActive: true, dayOfMonth: 10, accountId: CHECKING_ACCOUNT.id };
  // Em 04/09: salário (dia 24) ainda não chegou (UPCOMING, 24/09); bico (dia 10)
  // também ainda não chegou (UPCOMING, 10/09) — o bico é cronologicamente antes.
  const result = resolveNextExpectedIncome({ now: d("2026-09-04"), recurringRules: [SALARY_RULE, secondJobRule], accounts: ACCOUNTS, settings: SETTINGS });
  check(
    "duas rendas irrestritas → escolhe a ocorrência cronologicamente mais próxima (bico dia 10, não salário dia 24)",
    iso(result.expectedDate) === "2026-09-10" && result.recurringRuleId === secondJobRule.id,
    JSON.stringify({ ...result, expectedDate: iso(result.expectedDate) })
  );

  // Em 15/09: bico (dia 10) já passou sem Income -> OVERDUE, 10/09. Isso deve
  // vencer o salário (dia 24, ainda UPCOMING) na escolha cronológica.
  const resultAfterBicoDue = resolveNextExpectedIncome({ now: d("2026-09-15"), recurringRules: [SALARY_RULE, secondJobRule], realizedIncomes: [], accounts: ACCOUNTS, settings: SETTINGS });
  check(
    "bico OVERDUE (10/09) tem prioridade cronológica sobre salário UPCOMING (24/09)",
    iso(resultAfterBicoDue.expectedDate) === "2026-09-10" && resultAfterBicoDue.status === INCOME_HORIZON_STATUS.OVERDUE,
    JSON.stringify({ ...resultAfterBicoDue, expectedDate: iso(resultAfterBicoDue.expectedDate) })
  );
}

// ---- Sem recurring income -> fallback explícito ----
{
  const result = resolveNextExpectedIncome({ now: d("2026-09-04"), recurringRules: [], accounts: ACCOUNTS, settings: SETTINGS });
  check(
    "sem nenhuma RecurringRule de renda → FALLBACK explícito (isFallback=true), data = próximo início de ciclo (24/09)",
    result.status === INCOME_HORIZON_STATUS.FALLBACK && result.isFallback === true && iso(result.expectedDate) === "2026-09-24",
    JSON.stringify({ ...result, expectedDate: iso(result.expectedDate) })
  );
}

// ---- Item 10: nunca altera saldo/caixa — resolveNextExpectedIncome não tem
// nenhum acesso a Account.balance/unrestrictedCash; confirma que o retorno não
// carrega nenhum campo monetário (é só data + status + metadados).
{
  const result = resolveNextExpectedIncome({ now: d("2026-09-04"), recurringRules: [SALARY_RULE], accounts: ACCOUNTS, settings: SETTINGS });
  const keys = Object.keys(result).sort();
  check(
    "retorno não contém nenhum campo monetário (só expectedDate/status/recurringRuleId/accountId/isFallback)",
    JSON.stringify(keys) === JSON.stringify(["accountId", "expectedDate", "isFallback", "recurringRuleId", "status"].sort())
  );
}

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) console.log("Alguns testes falharam — ver ❌ acima.");
