// Fase 5.1D-ITAÚ — testes sintéticos do matcher genérico (row-by-row matching).
// 100% dado fictício (MARK = "TESTE_FASE51D"). Nenhuma escrita no banco — testa só
// as funções puras exportadas de scripts/investigate-fase51d-itau.mjs.
import { matchOperationalMovements, tokenOverlapScore } from "./investigate-fase51d-itau.mjs";
import { money } from "../lib/money.js";

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

function row({ id, model, amount, description }) {
  return { id, model, amount: money(amount), description, occurredAt: new Date("2026-08-29T23:00:00.000Z"), source: "telegram", confidence: null, createdAt: new Date("2026-08-29T23:00:00.000Z"), consumed: false };
}

function item({ index, description, amount, semanticHint = "EXPENSE" }) {
  return { index, description, amount: money(amount), semanticHint, note: null };
}

// --- [A] match único exato (mesmo valor+sinal, único candidato) ---
{
  const canonical = [item({ index: 1, description: "TESTE_FASE51D farmácia", amount: -18.27 })];
  const db = [row({ id: "e1", model: "Expense", amount: -18.27, description: "TESTE_FASE51D paguei 18,27 na farmacia" })];
  const results = matchOperationalMovements(canonical, db);
  check(results.length === 1 && results[0].status === "UNIQUE_BACKFILL_MATCH", "[A] match único exato classificado como UNIQUE_BACKFILL_MATCH");
  check(results[0].matchedDbId === "e1", "[A] matchedDbId aponta pra row correta");
}

// --- [B] MISSING quando nenhuma row tem o mesmo valor+sinal ---
{
  const canonical = [item({ index: 1, description: "TESTE_FASE51D aluguel", amount: -1000 })];
  const db = [row({ id: "e1", model: "Expense", amount: -50, description: "TESTE_FASE51D gasolina" })];
  const results = matchOperationalMovements(canonical, db);
  check(results[0].status === "MISSING", "[B] sem candidato de mesmo valor+sinal => MISSING");
}

// --- [C] AMBIGUOUS quando múltiplos candidatos empatados sem sinal textual ---
{
  const canonical = [
    item({ index: 1, description: "TESTE_FASE51D gasolina", amount: -50 }),
    item({ index: 2, description: "TESTE_FASE51D gasolina", amount: -50 }),
  ];
  const db = [
    row({ id: "e1", model: "Expense", amount: -50, description: "TESTE_FASE51D corte de cabelo" }),
    row({ id: "e2", model: "Expense", amount: -50, description: "TESTE_FASE51D pet hotel" }),
    row({ id: "e3", model: "Expense", amount: -50, description: "TESTE_FASE51D botei gasolina no pix" }),
    row({ id: "e4", model: "Expense", amount: -50, description: "TESTE_FASE51D botei gasolina no pix" }),
  ];
  const results = matchOperationalMovements(canonical, db);
  check(results[0].status === "AMBIGUOUS" && results[1].status === "AMBIGUOUS", "[C] múltiplos candidatos empatados (mesmo texto) => AMBIGUOUS pros dois itens canônicos, nunca um match forçado");
  check(db.every((r) => !r.consumed), "[C] nenhuma row é consumida quando a classificação é AMBIGUOUS");
}

// --- [D] desambiguação por texto quando um candidato tem sinal textual único ---
{
  const canonical = [item({ index: 1, description: "TESTE_FASE51D farmácia", amount: -50 })];
  const db = [
    row({ id: "e1", model: "Expense", amount: -50, description: "TESTE_FASE51D corte de cabelo" }),
    row({ id: "e2", model: "Expense", amount: -50, description: "TESTE_FASE51D paguei na farmacia" }),
  ];
  const results = matchOperationalMovements(canonical, db);
  check(results[0].status === "UNIQUE_BACKFILL_MATCH" && results[0].matchedDbId === "e2", "[D] desambiguação por overlap textual escolhe o candidato certo (farmácia), não o genérico");
}

// --- [E] cada row do DB só pode ser consumida por UM item canônico (nunca dupla contagem) ---
{
  const canonical = [
    item({ index: 1, description: "TESTE_FASE51D água", amount: -59.27 }),
    item({ index: 2, description: "TESTE_FASE51D água", amount: -59.27 }),
  ];
  const db = [row({ id: "e1", model: "Expense", amount: -59.27, description: "TESTE_FASE51D conta de agua" })];
  const results = matchOperationalMovements(canonical, db);
  const matchedCount = results.filter((r) => r.status === "UNIQUE_BACKFILL_MATCH" && r.matchedDbId === "e1").length;
  check(matchedCount === 1, "[E] uma única row do DB nunca é usada por mais de um item canônico");
  check(results.filter((r) => r.status === "MISSING").length === 1, "[E] o segundo item canônico (sem candidato restante) vira MISSING, não um match duplicado");
}

// --- [F] tokenOverlapScore: score alto pra descrições com palavras em comum, zero sem overlap ---
{
  check(tokenOverlapScore("TESTE_FASE51D conta de agua", "TESTE_FASE51D pix conta de agua gabriel") > 0.5, "[F] tokenOverlapScore alto quando as descrições compartilham palavras-chave");
  check(tokenOverlapScore("farmácia", "corte de cabelo") === 0, "[F] tokenOverlapScore zero quando não há palavras em comum");
}

// --- [G] checksum de decomposição: opening + net = checkpoint, sempre exato (Decimal) ---
{
  const { addMoney, subtractMoney, sumMoney } = await import("../lib/money.js");
  const checkpointA = money("1000.00");
  const canonicalNet = sumMoney([money("500.00"), money("-200.00"), money("-50.03")]);
  const derivedOpening = subtractMoney(checkpointA, canonicalNet);
  const reconstructed = addMoney(derivedOpening, canonicalNet);
  check(reconstructed.toString() === checkpointA.toString(), "[G] opening derivado + net canônico reconstrói o checkpoint exatamente (Decimal, sem erro de arredondamento)");
}

console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
if (failed > 0) process.exit(1);
