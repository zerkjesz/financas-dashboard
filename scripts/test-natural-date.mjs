// Fase 5.3D — NATURAL DATE TEST MATRIX (item 31). Puro, sem banco/servidor —
// só lib/naturalDate.js:resolveEconomicDate/mentionsPastTense. Fixtures
// 100% fictícias.
import { resolveEconomicDate, ECONOMIC_DATE_STATUS, mentionsPastTense } from "../lib/naturalDate.js";

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

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

// "hoje" de referência fixo pro teste inteiro: quarta-feira, 2026-09-09T12:00:00Z.
const NOW = new Date("2026-09-09T12:00:00.000Z");

console.log("--- Fase 5.3D: Natural Date Test Matrix ---\n");

// [A] sem marcador -> hoje local (item 22).
{
  const r = resolveEconomicDate("gastei 50 no mercado", NOW);
  check(r.status === ECONOMIC_DATE_STATUS.TODAY, "[A] sem marcador de data -> status TODAY");
  check(ymd(r.date) === "2026-09-09", "[A] sem marcador -> resolve pra hoje", ymd(r.date));
}

// [B] "ontem" -> yesterday.
{
  const r = resolveEconomicDate("gastei 50 ontem no mercado", NOW);
  check(r.status === ECONOMIC_DATE_STATUS.RESOLVED, "[B] 'ontem' -> RESOLVED");
  check(ymd(r.date) === "2026-09-08", "[B] 'ontem' -> dia anterior", ymd(r.date));
}

// [C] "anteontem".
{
  const r = resolveEconomicDate("gastei 50 anteontem", NOW);
  check(r.status === ECONOMIC_DATE_STATUS.RESOLVED, "[C] 'anteontem' -> RESOLVED");
  check(ymd(r.date) === "2026-09-07", "[C] 'anteontem' -> 2 dias antes", ymd(r.date));
}

// [D] DD/MM explícito.
{
  const r = resolveEconomicDate("gastei 50 dia 03/09", NOW);
  check(r.status === ECONOMIC_DATE_STATUS.RESOLVED, "[D] DD/MM explícito -> RESOLVED");
  check(ymd(r.date) === "2026-09-03", "[D] 03/09 -> 2026-09-03", ymd(r.date));
}

// [E] DD/MM/AAAA explícito.
{
  const r = resolveEconomicDate("gastei 50 em 15/08/2026", NOW);
  check(r.status === ECONOMIC_DATE_STATUS.RESOLVED, "[E] DD/MM/AAAA explícito -> RESOLVED");
  check(ymd(r.date) === "2026-08-15", "[E] 15/08/2026 -> exato", ymd(r.date));
}

// [F] weekday -> ÚLTIMA ocorrência (nunca futura) — item 20, o bug corrigido.
// NOW = quarta 2026-09-09. "sábado" mencionado numa Expense retrospectiva
// deve ser o sábado ANTERIOR (2026-09-05), nunca o próximo (2026-09-12).
{
  const r = resolveEconomicDate("gastei 50 sabado no mercado", NOW);
  check(r.status === ECONOMIC_DATE_STATUS.RESOLVED, "[F] weekday -> RESOLVED");
  check(ymd(r.date) === "2026-09-05", "[F] 'sábado' a partir de quarta -> o sábado PASSADO (05/09), nunca o futuro (12/09)", ymd(r.date));
  check(r.date <= NOW, "[F] data resolvida nunca é futura pra um relato retrospectivo");
}

// [F2] weekday igual ao dia de hoje: "quarta" mencionado numa quarta-feira ->
// hoje mesmo (não deveria voltar 7 dias).
{
  const r = resolveEconomicDate("gastei 50 quarta no mercado", NOW);
  check(ymd(r.date) === "2026-09-09", "[F2] weekday igual a hoje -> hoje mesmo, não 7 dias atrás", ymd(r.date));
}

// [G] "semana passada" -> AMBIGUOUS, nunca um chute.
{
  const r = resolveEconomicDate("gastei 50 semana passada", NOW);
  check(r.status === ECONOMIC_DATE_STATUS.AMBIGUOUS, "[G] 'semana passada' -> AMBIGUOUS (nunca resolve sozinho)");
  check(r.date === undefined, "[G] AMBIGUOUS nunca vem acompanhado de uma data chutada");
}

// [H] "mês passado" -> AMBIGUOUS.
{
  const r = resolveEconomicDate("gastei 50 mes passado", NOW);
  check(r.status === ECONOMIC_DATE_STATUS.AMBIGUOUS, "[H] 'mês passado' -> AMBIGUOUS");
}

// outros marcadores vagos também nunca resolvem sozinhos.
for (const phrase of ["gastei 50 esses dias", "gastei 50 essa semana", "gastei 50 recentemente"]) {
  const r = resolveEconomicDate(phrase, NOW);
  check(r.status === ECONOMIC_DATE_STATUS.AMBIGUOUS, `[G/H extra] "${phrase}" -> AMBIGUOUS`);
}

// [L] ambíguo nunca vira hoje silenciosamente — reforça G/H com uma
// asserção direta contra TODAY.
{
  const r = resolveEconomicDate("gastei 50 semana passada", NOW);
  check(r.status !== ECONOMIC_DATE_STATUS.TODAY, "[L] marcador ambíguo NUNCA cai silenciosamente em TODAY");
}

// item 27 — mentionsPastTense: usado só pra bloquear balance_adjustment
// retroativo, nunca pra inventar uma data.
check(mentionsPastTense("meu saldo era 800 ontem") === true, "[27] 'meu saldo era 800 ontem' -> mentionsPastTense=true (bloqueia)");
check(mentionsPastTense("meu saldo no itau é 800 reais") === false, "[27] 'meu saldo é 800' (sem marcador de passado) -> mentionsPastTense=false (permite, é 'agora')");

console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
if (failed > 0) process.exit(1);
