import { prisma } from "./prisma.js";

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
