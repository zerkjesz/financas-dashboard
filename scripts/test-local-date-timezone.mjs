// Fase 5.3D.1 — LOCAL-DATE / TIMEZONE CLOSURE (itens 9/11/12/16). Puro, sem
// banco/servidor — só lib/naturalDate.js:resolveEconomicDate e
// lib/appTimezone.js. Fixtures 100% fictícias.
import { resolveEconomicDate, ECONOMIC_DATE_STATUS } from "../lib/naturalDate.js";
import { localCalendarDateAsUtcMidnight } from "../lib/appTimezone.js";
import { getCardCycleForDate } from "../lib/cardCycle.js";

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

const TZ = "America/Sao_Paulo"; // UTC-3, sem DST atualmente — offset negativo, exatamente o caso que expõe o bug de "UTC vira o dia antes da hora local".

console.log("--- Fase 5.3D.1: Local-Date / Timezone Matrix ---\n");

// ==========================================================================
// Item 9 — MIDNIGHT BOUNDARY MATRIX
// ==========================================================================
console.log("--- Midnight boundary (item 9) ---");

// [A] local 08/09 20:00 -03:00 = UTC 08/09 23:00Z -> hoje=08/09, ontem=07/09.
// (não cruza a virada UTC — caso de controle, sem bug possível mesmo antes da correção.)
{
  const instant = new Date("2026-09-08T23:00:00.000Z");
  const r = resolveEconomicDate("gastei 50 ontem", instant, TZ);
  check(ymd(r.date) === "2026-09-07", "[A] local 08/09 20:00 -03:00 -> 'ontem' = 07/09", `instant=${instant.toISOString()} local~20:00 -> ${ymd(r.date)}`);
}

// [B] CRÍTICO — local 08/09 23:30 -03:00 = UTC JÁ é 09/09 02:30Z. O bug real
// (corrigido nesta fase): usar a data UTC crua faria "hoje"=09/09 e
// "ontem"=08/09 — ERRADO. O usuário, às 23:30 no relógio dele, ainda está no
// dia 08/09; "ontem" pra ele é 07/09.
{
  const instant = new Date("2026-09-09T02:30:00.000Z"); // UTC já rolou pro dia 09.
  const localToday = localCalendarDateAsUtcMidnight(instant, TZ);
  check(ymd(localToday) === "2026-09-08", "[B] instant com data UTC=09/09 mas hora local=08/09 23:30 -> calendar date LOCAL continua 08/09 (não 09/09)", `instant UTC=${instant.toISOString()} -> local calendar=${ymd(localToday)}`);
  const r = resolveEconomicDate("gastei 50 ontem", instant, TZ);
  check(ymd(r.date) === "2026-09-07", "[B] 'ontem' nesse instant -> 07/09 (nunca 08/09, que seria o bug: tratar 09/09 UTC como hoje)", ymd(r.date));
}

// [C] local 08/09 00:30 -03:00 = UTC 08/09 03:30Z -> hoje ainda = 08/09.
{
  const instant = new Date("2026-09-08T03:30:00.000Z");
  const localToday = localCalendarDateAsUtcMidnight(instant, TZ);
  check(ymd(localToday) === "2026-09-08", "[C] local 08/09 00:30 -03:00 -> calendar date local = 08/09", ymd(localToday));
}

// [D] anteontem no mesmo boundary crítico do [B].
{
  const instant = new Date("2026-09-09T02:30:00.000Z");
  const r = resolveEconomicDate("gastei 50 anteontem", instant, TZ);
  check(ymd(r.date) === "2026-09-06", "[D] 'anteontem' no boundary crítico -> 06/09 (2 dias antes do 08/09 local, nunca baseado no 09/09 UTC)", ymd(r.date));
}

// ==========================================================================
// Item E/11 — weekday usa calendar date LOCAL; explicit date NUNCA sofre shift.
// ==========================================================================
console.log("\n--- Weekday local + explicit date sem shift (itens E/11) ---");

// [E] weekday: instant no boundary crítico (UTC já é quarta 09/09 de
// madrugada, mas local ainda é terça 08/09 à noite) — "segunda" mencionada
// deve resolver pra segunda ANTERIOR à terça LOCAL (07/09), não a partir de
// quarta (que daria uma segunda diferente só por causa do UTC).
{
  const instant = new Date("2026-09-09T02:30:00.000Z"); // local: terça 08/09 23:30.
  const r = resolveEconomicDate("gastei 50 segunda", instant, TZ);
  check(ymd(r.date) === "2026-09-07", "[E] weekday 'segunda' calculado a partir do calendar date LOCAL (terça 08/09), não do UTC (quarta 09/09)", ymd(r.date));
}

// [item 11] DD/MM explícito nunca desloca — testado no MESMO boundary crítico.
{
  const instant = new Date("2026-09-09T02:30:00.000Z");
  const r = resolveEconomicDate("gastei 50 dia 08/09", instant, TZ);
  check(ymd(r.date) === "2026-09-08", "[item 11] '08/09' explícito permanece 08/09 mesmo no boundary UTC crítico (nunca sofre shift de timezone)", ymd(r.date));
}
{
  const instant = new Date("2026-09-09T02:30:00.000Z");
  const r = resolveEconomicDate("gastei 50 em 08/09/2026", instant, TZ);
  check(ymd(r.date) === "2026-09-08", "[item 11] '08/09/2026' explícito (com ano) também permanece exato", ymd(r.date));
}

// ==========================================================================
// Item 12 — CARD CYCLE BOUNDARY: closingDay=4, purchase nos dias 03/04/05,
// confirma que a data econômica correta (sem shift UTC) chega em
// getCardCycleForDate.
// ==========================================================================
console.log("\n--- Card cycle boundary, closingDay=4 (item 12) ---");
const fakeCard = { closingDay: 4, dueDay: 11 };

{
  // Compra no dia 03 (ANTES do fechamento) -> ainda pertence ao ciclo que fecha dia 04 deste mês.
  const purchaseDate = new Date(Date.UTC(2026, 8, 3)); // 2026-09-03, já como calendar-date correta (simula o output de resolveEconomicDate).
  const cycle = getCardCycleForDate(fakeCard, purchaseDate);
  check(cycle === "2026-09", "[card cycle] compra dia 03 (antes do fechamento dia 04) -> ciclo 2026-09", cycle);
}
{
  // Compra no dia 05 (DEPOIS do fechamento) -> já pertence ao ciclo seguinte.
  const purchaseDate = new Date(Date.UTC(2026, 8, 5));
  const cycle = getCardCycleForDate(fakeCard, purchaseDate);
  check(cycle === "2026-10", "[card cycle] compra dia 05 (depois do fechamento dia 04) -> ciclo 2026-10 (já fechou)", cycle);
}
{
  // Ponta a ponta: resolveEconomicDate corretamente ancorado -> getCardCycleForDate.
  // Instant no boundary crítico (UTC já rolou), mensagem "dia 03" explícita.
  const instant = new Date("2026-09-04T02:30:00.000Z"); // UTC já é dia 04; local (TZ) ainda é dia 03 à noite.
  const r = resolveEconomicDate("comprei dia 03", instant, TZ);
  check(ymd(r.date) === "2026-09-03", "[card cycle e2e] 'dia 03' resolvido corretamente mesmo com UTC já em 04", ymd(r.date));
  const cycle = getCardCycleForDate(fakeCard, r.date);
  check(cycle === "2026-09", "[card cycle e2e] ciclo resultante é 2026-09 (dia 03, antes do fechamento) — nunca deslocado pro ciclo seguinte por causa do UTC", cycle);
}

console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
if (failed > 0) process.exit(1);
