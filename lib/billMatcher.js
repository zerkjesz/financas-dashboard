import { prisma } from "./prisma.js";
import { normalize } from "./categoryRules.js";

const STOPWORDS = new Set([
  "de", "da", "do", "das", "dos", "para", "pra", "com", "no", "na", "nos", "nas",
  "os", "as", "um", "uma", "uns", "umas", "e", "o", "a", "que", "meu", "minha",
  "meus", "minhas", "ja", "aquele", "aquela", "aqueles", "aquelas", "reais", "real",
  "paguei", "pagamento", "pagar", "quitei", "mandei", "conta", "valor",
]);

function significantWords(text) {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Pontua as Bill pendentes/atrasadas contra a mensagem: valor batendo é o sinal mais forte,
// sobreposição de palavras da descrição é o sinal secundário. `hadAnyPending` distingue "não
// tinha nenhuma conta pendente pra bater" de "tinha, mas nenhuma pareceu com essa mensagem" —
// só a segunda situação deve gerar uma pergunta pro usuário, a primeira só vira despesa normal.
export async function findMatchingBills(rawMessage, amount) {
  const bills = await prisma.bill.findMany({
    where: { status: { in: ["pending", "overdue"] } },
    orderBy: { dueDate: "asc" },
  });
  if (bills.length === 0) return { candidates: [], hadAnyPending: false };

  const messageWords = new Set(significantWords(rawMessage));

  const scored = bills.map((bill) => {
    const amountMatches = amount != null && Math.abs(bill.amount - amount) < 0.01;
    const billWords = significantWords(bill.description);
    const overlap = billWords.filter((w) => messageWords.has(w)).length;
    const score = (amountMatches ? 3 : 0) + overlap;
    return { bill, score };
  });

  const candidates = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.bill);

  return { candidates, hadAnyPending: true };
}
