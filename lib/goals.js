import { prisma } from "./prisma.js";
import { normalize } from "./categoryRules.js";

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

export async function addToGoal(goalId, amount) {
  const goal = await prisma.goal.findUnique({ where: { id: goalId } });
  if (!goal) throw new Error("Meta não encontrada");
  return prisma.goal.update({ where: { id: goalId }, data: { savedAmount: goal.savedAmount + amount } });
}

// Se tem targetDate usa ela; senão projeta pela taxa média de quanto já foi guardado por mês.
export function estimateGoalForecast(goal) {
  const remaining = Math.max(0, goal.targetAmount - goal.savedAmount);
  if (goal.targetDate) {
    return { remaining, forecastDate: goal.targetDate, forecastBasis: "targetDate" };
  }
  if (goal.savedAmount <= 0 || remaining === 0) {
    return { remaining, forecastDate: null, forecastBasis: "sem_dados" };
  }
  const monthsSinceCreated = Math.max(1, (Date.now() - new Date(goal.createdAt).getTime()) / (1000 * 60 * 60 * 24 * 30));
  const ratePerMonth = goal.savedAmount / monthsSinceCreated;
  if (ratePerMonth <= 0) return { remaining, forecastDate: null, forecastBasis: "sem_dados" };
  const monthsRemaining = remaining / ratePerMonth;
  const forecastDate = new Date(Date.now() + monthsRemaining * 30 * 24 * 60 * 60 * 1000);
  return { remaining, forecastDate, forecastBasis: "taxa_media" };
}
