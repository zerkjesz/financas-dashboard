import { normalize, detectCategory } from "./categoryRules.js";
import { extractAmount } from "./amountExtractor.js";
import { classifyIntent, detectRecurring } from "./intentClassifier.js";
import { resolvePaymentTarget } from "./accountResolver.js";

// Orquestrador: classifica a intenção, extrai o valor, resolve categoria/conta/cartão.
// Retorna null se não achar nenhum valor monetário na mensagem.
export async function parseTransaction(rawMessage) {
  const { amount, ambiguous, candidates } = extractAmount(rawMessage);
  if (amount === null) return null;

  const { intent, installmentCount } = classifyIntent(rawMessage);
  const normalizedText = normalize(rawMessage);
  const target = await resolvePaymentTarget(rawMessage);

  const data = {
    amount,
    category: detectCategory(normalizedText),
    isRecurring: detectRecurring(rawMessage),
    description: rawMessage.trim(),
    rawMessage: rawMessage.trim(),
    target,
  };

  if (intent === "installment_purchase") {
    data.installmentCount = installmentCount || null;
  }

  let needsConfirmation = ambiguous;
  let confirmationPrompt = ambiguous ? buildAmountConfirmation(amount, candidates) : null;

  if (intent === "installment_purchase" && !data.installmentCount) {
    needsConfirmation = true;
    confirmationPrompt = "Entendi uma compra parcelada, mas não achei em quantas vezes. Pode me falar de novo incluindo algo tipo \"em 10x\"?";
  }

  return { intent, data, needsConfirmation, confirmationPrompt, rawMessage: rawMessage.trim() };
}

function buildAmountConfirmation(amount, candidates) {
  const formatted = amount.toFixed(2).replace(".", ",");
  const others = candidates.filter((c) => c.value !== amount).map((c) => c.raw);
  const othersPart = others.length > 0 ? ` (não R$ ${others.join(", ")})` : "";
  return `Entendi o valor R$ ${formatted}${othersPart}. Confirma? (sim/não)`;
}
