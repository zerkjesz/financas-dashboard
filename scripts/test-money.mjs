// ============================================================================
// Testes puros de lib/money.js — SEM banco, SEM rede. Convenção do projeto:
// script Node + assert (não há framework de teste ainda). Roda com:
//   node scripts/test-money.mjs
// Sai com exit code 1 se qualquer asserção falhar.
// ============================================================================
import assert from "node:assert/strict";
import {
  money, addMoney, subtractMoney, multiplyMoney, divideMoney,
  compareMoney, minMoney, maxMoney, roundMoney, isZeroMoney, serializeMoney,
  sumMoney, isPositive, isNegative,
} from "../lib/money.js";

let passed = 0;
function test(label, fn) {
  try {
    fn();
    console.log(`✅ ${label}`);
    passed++;
  } catch (err) {
    console.log(`❌ ${label}`);
    console.log(`   ${err.message}`);
    process.exitCode = 1;
  }
}

// Igualdade monetária determinística — sempre via serializeMoney() (o valor
// final, arredondado, o mesmo que sairia numa API), nunca por aproximação.
function assertMoneyEqual(actual, expectedNumber, msg) {
  assert.strictEqual(serializeMoney(actual), expectedNumber, msg);
}

console.log("--- Testes puros de lib/money.js ---\n");

// --- O caso clássico que Float erra ---
test("0.1 + 0.2 = 0.30 (exato, não 0.30000000000000004)", () => {
  const result = addMoney(money("0.1"), money("0.2"));
  assertMoneyEqual(result, 0.3);
  assert.strictEqual(result.toString(), "0.3", "toString deve ser exatamente '0.3'");
  // Prova de que o Number nativo erra isso, pra deixar claro o que estamos evitando:
  assert.notStrictEqual(0.1 + 0.2, 0.3, "(controle) Number nativo de fato erra esse caso");
});

test("61.61 + 114.63 = 176.24", () => {
  assertMoneyEqual(addMoney(money("61.61"), money("114.63")), 176.24);
});

test("8730.47 - 7000 = 1730.47", () => {
  assertMoneyEqual(subtractMoney(money("8730.47"), money(7000)), 1730.47);
});

test("170.68 * 3 = 512.04", () => {
  assertMoneyEqual(multiplyMoney(money("170.68"), 3), 512.04);
});

test("2465 * 0.10 = 246.50", () => {
  assertMoneyEqual(multiplyMoney(money(2465), 0.1), 246.5);
});

test("209.11 - 35 = 174.11 (caso do saldo credor de cartão, docs/schema-v2-blueprint.md item 3)", () => {
  assertMoneyEqual(subtractMoney(money("209.11"), money(35)), 174.11);
});

// --- Comparação exata ---
test("comparação: 10.00 == 10", () => {
  assert.strictEqual(compareMoney(money("10.00"), money(10)), 0);
});

test("comparação: 10.01 > 10.00", () => {
  assert.strictEqual(compareMoney(money("10.01"), money("10.00")), 1);
});

test("comparação: 60.60 == 60.6 (mesmo formato de texto diferente)", () => {
  assert.strictEqual(compareMoney(money("60.60"), money("60.6")), 0);
});

// --- Zero ---
test("0.00 é zero", () => {
  assert.strictEqual(isZeroMoney(money("0.00")), true);
  assert.strictEqual(isZeroMoney(money(0)), true);
  assert.strictEqual(isZeroMoney(money(null)), true); // null -> Decimal(0) por design
});

test("0.01 não é zero", () => {
  assert.strictEqual(isZeroMoney(money("0.01")), false);
});

// --- Sinal ---
test("isPositive/isNegative", () => {
  assert.strictEqual(isPositive(money("0.01")), true);
  assert.strictEqual(isNegative(money("-0.01")), true);
  assert.strictEqual(isPositive(money(0)), false);
  assert.strictEqual(isNegative(money(0)), false);
});

// --- min/max ---
test("minMoney/maxMoney", () => {
  assertMoneyEqual(minMoney(money("10.00"), money("5.00")), 5);
  assertMoneyEqual(maxMoney(money("10.00"), money("5.00")), 10);
});

// --- Divisão + arredondamento (política documentada) ---
test("divisão: 512 / 3 mantém precisão até roundMoney arredondar (política half-up, 2 casas)", () => {
  const raw = divideMoney(money(512), 3); // 170.6666666...
  assert.strictEqual(raw.toDecimalPlaces(10).toString(), "170.6666666667", "divideMoney não deve arredondar sozinho (mantém precisão)");
  assertMoneyEqual(roundMoney(raw), 170.67); // half-up na 3a casa (6 -> arredonda pra cima)
});

test("roundMoney: meio-centavo (0.005) segue ROUND_HALF_UP", () => {
  assertMoneyEqual(roundMoney(money("0.005")), 0.01); // half-up: 0.005 -> 0.01
  assertMoneyEqual(roundMoney(money("1.245")), 1.25); // half-up: 1.245 -> 1.25
});

// --- Soma de muitos valores (o caso onde Float mais acumula erro) ---
test("soma de 106 valores tipo Expense não acumula erro (caso real do branch dev)", () => {
  // Reconstrói o padrão real: muitos valores com centavos, somados em sequência.
  const values = [];
  for (let i = 0; i < 106; i++) values.push((Math.random() * 500 + 0.5).toFixed(2));
  const decimalSum = sumMoney(values);
  // Soma paralela em Number puro, pra comparar:
  const floatSum = values.reduce((s, v) => s + Number(v), 0);
  // O ponto do teste não é que floatSum necessariamente erre neste caso específico
  // (pode ou não, depende dos valores sorteados) — é que decimalSum é
  // DETERMINISTICAMENTE exato, sempre, o que Number nunca garante.
  const expected = values.reduce((s, v) => s + Math.round(Number(v) * 100), 0) / 100;
  assertMoneyEqual(decimalSum, Math.round(expected * 100) / 100);
});

test("soma de parcelas de CardBill: 3x de 170.68 fecha em 512.04 exato (não 512.03999999999996)", () => {
  const parcela = money("170.68");
  const total = addMoney(addMoney(parcela, parcela), parcela);
  assertMoneyEqual(total, 512.04);
  assert.strictEqual(total.toString(), "512.04");
});

// --- null/string/number de entrada ---
test("money(null) e money(undefined) viram 0", () => {
  assertMoneyEqual(money(null), 0);
  assertMoneyEqual(money(undefined), 0);
});

test("money(string) é exato — não passa por Number no meio", () => {
  // 0.1 em Number binário já não é exato — money(string) evita esse passo.
  assert.strictEqual(money("0.1").toString(), "0.1");
});

test("serializeMoneyFields converte só os campos monetários de um objeto", async () => {
  const { serializeMoneyFields } = await import("../lib/money.js");
  const obj = { id: "x", totalAmount: money("60.60"), paidAmount: null, description: "teste" };
  const out = serializeMoneyFields(obj, ["totalAmount", "paidAmount"]);
  assert.strictEqual(out.totalAmount, 60.6);
  assert.strictEqual(out.paidAmount, null);
  assert.strictEqual(out.description, "teste"); // campo não-monetário intocado
  assert.strictEqual(typeof out.totalAmount, "number");
});

console.log(`\n${process.exitCode === 1 ? "❌ Falhas encontradas." : `✅ ${passed} teste(s) passaram.`}`);
