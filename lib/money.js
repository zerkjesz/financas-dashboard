import { Prisma } from "@prisma/client";

const D = Prisma.Decimal;

// ============================================================================
// Camada monetária central do Norte v2 (Fase 3.1).
//
// Regra: DB Decimal -> cálculo financeiro em Decimal -> serialização só na
// borda/API. Number só existe ANTES de money() (entrada) e DEPOIS de
// serializeMoney()/serializeMoneyFields() (saída) — nunca no meio de um
// cálculo. Ver docs/phase3-money-audit.md, seção 5, pra justificativa completa.
//
// Usa Prisma.Decimal (== decimal.js por baixo, já é dependência transitiva do
// @prisma/client) — nenhuma biblioteca nova.
// ============================================================================

// Normaliza number, string, Decimal ou null/undefined pra Decimal.
// - null/undefined -> Decimal(0). Decisão deliberada: soma de campos monetários
//   opcionais (paidAmount, newTotalLimit etc.) não deve quebrar por causa de um
//   null solto. Se algum cálculo específico precisar diferenciar "não
//   informado" de "zero", quem chama checa `== null` ANTES de chamar money(),
//   não depois — money(null) e money(0) são indistinguíveis por design.
// - string -> parseada DIRETO pelo decimal.js, sem passar por Number no meio.
//   É a entrada preferida quando a origem é texto (ex: Telegram).
// - number -> aceito, mas é a entrada menos confiável (já passou por precisão
//   binária antes de chegar aqui).
// - Decimal -> devolvido como está.
export function money(value) {
  if (value == null) return new D(0);
  if (value instanceof D) return value;
  return new D(value);
}

export function addMoney(a, b) {
  return money(a).plus(money(b));
}

export function subtractMoney(a, b) {
  return money(a).minus(money(b));
}

// factor: number puro (percentual, contagem de parcelas) — não precisa ser Money.
export function multiplyMoney(a, factor) {
  return money(a).times(factor);
}

// divisor: number puro. NÃO arredonda sozinho — decimal.js por padrão mantém
// muitos dígitos significativos numa divisão. Quem chama decide quando (e se)
// arredondar via roundMoney(), explicitamente, no momento certo (ex: só depois
// de calcular a última parcela por subtração, não a cada parcela individual —
// ver lib/installments.js).
export function divideMoney(a, divisor) {
  return money(a).dividedBy(divisor);
}

export function sumMoney(values) {
  return values.reduce((acc, v) => acc.plus(money(v)), new D(0));
}

// -1 | 0 | 1 — usar em vez de `a > b`/`a === b`, que não funcionam certo em
// objetos Decimal (comparação de referência/coerção incorreta).
export function compareMoney(a, b) {
  return money(a).comparedTo(money(b));
}

export function isPositive(v) {
  return money(v).greaterThan(0);
}

export function isNegative(v) {
  return money(v).lessThan(0);
}

export function isZeroMoney(v) {
  return money(v).isZero();
}

export function maxMoney(a, b) {
  return compareMoney(a, b) >= 0 ? money(a) : money(b);
}

export function minMoney(a, b) {
  return compareMoney(a, b) <= 0 ? money(a) : money(b);
}

// Arredondamento EXPLÍCITO — half-up, 2 casas, política oficial deste projeto
// pra Real. Nenhuma outra função deste arquivo arredonda por conta própria —
// arredondar é sempre uma decisão deliberada de quem chama, no momento certo
// (normalmente uma vez só, no fim de um cálculo, nunca a cada passo
// intermediário).
export function roundMoney(value, decimals = 2) {
  return money(value).toDecimalPlaces(decimals, D.ROUND_HALF_UP);
}

// ÚNICO ponto de conversão Decimal -> number. Só é chamado na BORDA — dentro
// de uma rota de API montando a resposta JSON, ou formatando pra exibição.
// NUNCA dentro de uma função de lib/ que ainda vai fazer mais conta com o
// resultado. Sempre arredonda antes de converter (nunca serializa um valor
// não-arredondado).
export function serializeMoney(value) {
  return roundMoney(value).toNumber();
}

// Conveniência: serializa vários campos monetários de um objeto de uma vez, na
// borda da API — reduz o risco de esquecer um campo (Prisma.Decimal.toJSON()
// retorna STRING, não number, se vazar cru — ver docs/phase3-money-audit.md,
// seção 4/9, o maior risco de regressão silenciosa desta migration).
export function serializeMoneyFields(obj, fields) {
  const out = { ...obj };
  for (const f of fields) {
    if (out[f] != null) out[f] = serializeMoney(out[f]);
  }
  return out;
}

// Fronteira explícita de serialização (Fase 3.1, Etapa 9) — anotar campo por campo
// numa resposta de API grande e aninhada (dashboard, cartões, etc.) é fácil de
// esquecer um; deepSerializeMoney varre a árvore inteira (objetos, arrays) e
// converte QUALQUER Prisma.Decimal encontrado em number puro via serializeMoney(),
// preservando Date/String/Number/Boolean/null como estão. É a única forma seguura
// de garantir que nenhum Decimal cru chegue no NextResponse.json() — o risco real:
// Prisma.Decimal.toJSON() devolve STRING, não number, se vazar sem passar por aqui.
export function deepSerializeMoney(value) {
  if (value == null) return value;
  if (value instanceof D) return serializeMoney(value);
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(deepSerializeMoney);
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepSerializeMoney(value[key]);
    return out;
  }
  return value;
}

export const ZERO = new D(0);
