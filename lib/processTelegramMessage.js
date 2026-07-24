import { prisma } from "./prisma.js";
import { parseTransaction } from "./parseTransaction.js";

const PAYMENT_LABELS = {
  pix: "Pix",
  credit_card: "Cartão de Crédito",
  food_voucher: "Vale Alimentação",
};

/**
 * Interpreta e grava uma mensagem de texto livre do Telegram como transação.
 * Usado tanto pelo bot em polling (bot/telegram-bot.js) quanto pelo webhook
 * (app/api/telegram/webhook/route.js) quando hospedado.
 */
export async function processTelegramMessage(text) {
  const parsed = parseTransaction(text);
  if (!parsed) {
    return {
      ok: false,
      reply: 'Não consegui achar um valor nessa mensagem. Tenta algo tipo "50 mercado pix" ou "recebi 200 freela".',
    };
  }

  const transaction = await prisma.transaction.create({
    data: {
      type: parsed.type,
      amount: parsed.amount,
      category: parsed.category,
      paymentMethod: parsed.paymentMethod,
      isRecurring: parsed.isRecurring,
      installmentCurrent: parsed.installmentCurrent,
      installmentTotal: parsed.installmentTotal,
      description: parsed.description,
      rawMessage: parsed.rawMessage,
      source: "telegram",
    },
  });

  const label = parsed.type === "income" ? "Receita" : "Gasto";
  const sign = parsed.type === "income" ? "+" : "-";
  const paymentPart = parsed.paymentMethod ? ` via ${PAYMENT_LABELS[parsed.paymentMethod]}` : "";
  const recurringPart = parsed.isRecurring ? " 🔁 fixo" : "";
  const installmentPart = parsed.installmentTotal
    ? ` [parcela ${parsed.installmentCurrent}/${parsed.installmentTotal}]`
    : "";

  return {
    ok: true,
    transaction,
    reply: `✅ ${label} registrado: ${sign}R$ ${parsed.amount.toFixed(2)} (${parsed.category}${paymentPart})${recurringPart}${installmentPart}`,
  };
}
