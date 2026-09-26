// Fase 10 — composição do read-model de /cartoes (Itaú + Caju). SOMENTE LEITURA.
import { prisma } from "./prisma.js";
import { buildItauModel } from "./cardsItau.js";
import { buildCajuModel } from "./cardsCaju.js";

export async function buildCardsAreaModel({ now = new Date(), client = prisma } = {}) {
  const [itau, caju] = await Promise.all([buildItauModel({ now, client }), buildCajuModel({ now, client })]);
  return { generatedAt: now.toISOString(), cards: [itau ? "itau" : null, caju ? "caju" : null].filter(Boolean), itau, caju };
}
