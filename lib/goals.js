import { prisma } from "./prisma.js";
import { normalize } from "./categoryRules.js";
import { money, addMoney, subtractMoney, divideMoney, maxMoney, isZeroMoney, isPositive, ZERO } from "./money.js";

const STOPWORDS = new Set(["de", "da", "do", "para", "pra", "meu", "minha", "guardei", "separei", "mais", "meta"]);

function significantWords(text) {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Mesma lógica de lib/billMatcher.js, adaptada pra Goal.name em vez de Bill.description.
export async function findMatchingGoals(hintText) {
  const goals = await prisma.goal.findMany({ where: { isActive: true } });
  if (goals.length === 0) return [];
  const hintWords = new Set(significantWords(hintText));
  return goals
    .map((goal) => ({ goal, overlap: significantWords(goal.name).filter((w) => hintWords.has(w)).length }))
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .map((s) => s.goal);
}

export async function listGoals() {
  const goals = await prisma.goal.findMany({ where: { isActive: true }, orderBy: { createdAt: "asc" } });
  return goals.map((goal) => ({ ...goal, ...estimateGoalForecast(goal) }));
}

// Decimal-first (Fase 3.1): `amount` chega como number puro (fronteira de entrada,
// Etapa 8) — convertido pra money() antes de somar com o Decimal já persistido.
// Fase 5.3C.2 — `client` opcional (default: `prisma`), mesmo padrão aditivo
// já usado no resto do projeto.
export async function addToGoal(goalId, amount, { client = prisma } = {}) {
  const goal = await client.goal.findUnique({ where: { id: goalId } });
  if (!goal) throw new Error("Meta não encontrada");
  return client.goal.update({ where: { id: goalId }, data: { savedAmount: addMoney(goal.savedAmount, money(amount)) } });
}

// Se tem targetDate usa ela; senão projeta pela taxa média de quanto já foi guardado por mês.
// Decimal-first: `remaining` devolvido é Decimal — serializeMoney() só na borda da API.
export function estimateGoalForecast(goal) {
  const remaining = maxMoney(ZERO, subtractMoney(goal.targetAmount, goal.savedAmount));
  if (goal.targetDate) {
    return { remaining, forecastDate: goal.targetDate, forecastBasis: "targetDate" };
  }
  if (!isPositive(goal.savedAmount) || isZeroMoney(remaining)) {
    return { remaining, forecastDate: null, forecastBasis: "sem_dados" };
  }
  const monthsSinceCreated = Math.max(1, (Date.now() - new Date(goal.createdAt).getTime()) / (1000 * 60 * 60 * 24 * 30));
  const ratePerMonth = divideMoney(goal.savedAmount, monthsSinceCreated);
  if (!isPositive(ratePerMonth)) return { remaining, forecastDate: null, forecastBasis: "sem_dados" };
  // monthsRemaining é uma contagem de meses (não dinheiro) — cruza pra number aqui,
  // igual daysBetween/nextOccurrence já fazem com datas em outros arquivos.
  const monthsRemaining = divideMoney(remaining, ratePerMonth).toNumber();
  const forecastDate = new Date(Date.now() + monthsRemaining * 30 * 24 * 60 * 60 * 1000);
  return { remaining, forecastDate, forecastBasis: "taxa_media" };
}
