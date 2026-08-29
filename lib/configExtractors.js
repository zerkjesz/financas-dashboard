import { extractAmount } from "./amountExtractor.js";

const TRIGGERS = {
  account: /\b(criar|nova|cadastrar)\s+conta\b\s*[:\-]?\s*/i,
  card: /\b(criar|novo|cadastrar)\s+cart[ãa]o\b\s*[:\-]?\s*/i,
  recurringBill: /\b(criar|nova|cadastrar)\s+conta\s+(fixa|recorrente)\b\s*[:\-]?\s*|\bconta\s+recorrente\b\s*[:\-]?\s*/i,
  goal: /\b(criar|nova|cadastrar)\s+meta\b\s*[:\-]?\s*/i,
};

function stripTrigger(text, re) {
  return text.replace(re, "").trim();
}

// "criar conta Inter" -> "Inter"
export function extractAccountName(rawMessage) {
  return stripTrigger(rawMessage, TRIGGERS.account) || null;
}

// "criar cartão Nubank, limite 5000, fechamento dia 3, vencimento dia 10" (também aceita
// só o trecho depois do gatilho, pra reaproveitar quando o usuário responde só os campos
// que faltaram, sem repetir "criar cartão").
export function extractCardFields(text) {
  const remainder = stripTrigger(text, TRIGGERS.card);
  const parts = remainder.split(",").map((s) => s.trim()).filter(Boolean);
  const name = /limite|fechamento|vencimento/i.test(parts[0] || "") ? null : parts[0] || null;
  let totalLimit = null;
  let closingDay = null;
  let dueDay = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    const dayMatch = part.match(/dia\s*(\d{1,2})/i);
    if (lower.includes("limite")) {
      const { amount } = extractAmount(part);
      if (amount != null) totalLimit = amount;
    } else if (lower.includes("fechamento") && dayMatch) {
      closingDay = parseInt(dayMatch[1], 10);
    } else if (lower.includes("vencimento") && dayMatch) {
      dueDay = parseInt(dayMatch[1], 10);
    }
  }
  return { name, totalLimit, closingDay, dueDay };
}

// "criar conta fixa: Internet, 117 reais, todo dia 10"
export function extractRecurringBillFields(text) {
  const remainder = stripTrigger(text, TRIGGERS.recurringBill);
  const parts = remainder.split(",").map((s) => s.trim()).filter(Boolean);
  const name = /dia\s*\d|reais|r\$/i.test(parts[0] || "") ? null : parts[0] || null;
  const { amount } = extractAmount(remainder);
  const dayMatch = remainder.match(/dia\s*(\d{1,2})/i);
  const dayOfMonth = dayMatch ? parseInt(dayMatch[1], 10) : null;
  return { name, amount, dayOfMonth };
}

// "criar meta: guardar 1000 pra notebook"
export function extractGoalFields(text) {
  const remainder = stripTrigger(text, TRIGGERS.goal);
  const { amount } = extractAmount(remainder);
  const praMatch = remainder.match(/\bpr[ao]\s+(.+)$/i);
  let name = praMatch ? praMatch[1] : remainder.replace(/\bguardar\b/i, "");
  name = name.replace(/[\d.,]+\s*(reais|r\$)?/gi, "").trim();
  return { name: name || null, targetAmount: amount };
}

// "guardei mais 100 pra meta notebook" -> pista pra achar a meta: "notebook"
export function extractGoalHint(rawMessage) {
  const match = rawMessage.match(/\bmeta\s+(.+)$/i);
  return match ? match[1].trim() : rawMessage;
}
