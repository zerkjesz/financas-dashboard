import { normalize, detectCategory } from "./categoryRules.js";
import { extractAmount } from "./amountExtractor.js";
import { classifyIntent, detectRecurring } from "./intentClassifier.js";
import { resolvePaymentTarget } from "./accountResolver.js";
import { resolveDate } from "./naturalDate.js";
import { findMatchingBills } from "./billMatcher.js";

// Orquestrador: classifica a intenção, extrai o valor, resolve categoria/conta/cartão/data.
// Valor pode faltar em dois casos só: conta a pagar sem valor definido ainda ("preciso pagar
// a luz") e quitação de conta existente reconhecida só pela descrição ("paguei a internet") —
// qualquer outro caso sem valor retorna null (não dá pra registrar nada).
export async function parseTransaction(rawMessage) {
  const { amount, ambiguous, candidates } = extractAmount(rawMessage);
  const { intent: classifiedIntent, installmentCount, billPaymentKind, payVerbCandidate } = classifyIntent(rawMessage);

  if (amount === null && classifiedIntent !== "create_bill" && !payVerbCandidate) {
    return null;
  }

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

  let intent = classifiedIntent;
  let needsConfirmation = amount !== null && ambiguous;
  let confirmationPrompt = needsConfirmation ? buildAmountConfirmation(amount, candidates) : null;
  let pendingSelection = null;

  if (intent === "installment_purchase") {
    data.installmentCount = installmentCount || null;
    if (!data.installmentCount) {
      needsConfirmation = true;
      confirmationPrompt = "Entendi uma compra parcelada, mas não achei em quantas vezes. Pode me falar de novo incluindo algo tipo \"em 10x\"?";
    }
  }

  if (intent === "bill_payment") {
    data.billPaymentKind = billPaymentKind || "card_bill_payment";
  }

  if (intent === "create_bill") {
    const dueDate = await resolveDate(rawMessage);
    if (dueDate) data.dueDate = dueDate;

    if (amount !== null && dueDate) {
      // pronto pra commitar direto
    } else if (amount !== null && !dueDate) {
      needsConfirmation = true;
      confirmationPrompt = `Pra quando é "${data.description}"? Me diz a data (ex: "dia 20", "amanhã", "mês que vem").`;
      pendingSelection = { type: "provide_date" };
    } else if (amount === null && dueDate) {
      needsConfirmation = true;
      confirmationPrompt = `Quanto é "${data.description}"?`;
      pendingSelection = { type: "provide_amount" };
    } else {
      needsConfirmation = true;
      confirmationPrompt = `Quanto é e quando vence "${data.description}"? (ex: "300 reais dia 20")`;
      pendingSelection = { type: "provide_amount_and_date" };
    }
  }

  if (intent === "expense" && payVerbCandidate) {
    const { candidates: matches, hadAnyPending } = await findMatchingBills(rawMessage, amount);

    if (matches.length === 1) {
      intent = "pay_bill";
      data.billId = matches[0].id;
      if (data.amount === null) data.amount = matches[0].amount;
    } else if (matches.length > 1) {
      intent = "pay_bill";
      needsConfirmation = true;
      const list = matches.slice(0, 5).map((b, i) => `${i + 1}) ${b.description} — R$ ${b.amount.toFixed(2).replace(".", ",")}`).join("\n");
      confirmationPrompt = `Achei mais de uma conta parecida. Qual delas?\n${list}`;
      pendingSelection = { type: "choose_bill", candidates: matches.slice(0, 5).map((b) => ({ id: b.id, description: b.description, amount: b.amount })) };
    } else if (data.amount === null) {
      return null; // sem valor e sem nenhuma conta pra bater, não dá pra registrar nada
    } else if (hadAnyPending) {
      needsConfirmation = true;
      confirmationPrompt = `Não achei nenhuma conta pendente parecida com "${data.description}". Registro como despesa avulsa, ou isso é o pagamento de uma conta que eu deveria ter criado antes?`;
      pendingSelection = {
        type: "choose_option",
        options: [
          { key: "expense", label: "Registrar como despesa avulsa" },
          { key: "create_bill_paid", label: "Criar a conta e já marcar como paga" },
        ],
      };
    }
    // hadAnyPending === false: não existe nenhuma conta a pagar no sistema — segue como despesa normal, sem perguntar nada.
  }

  return {
    intent,
    data,
    needsConfirmation,
    confirmationPrompt,
    pendingSelection,
    rawMessage: rawMessage.trim(),
  };
}

function buildAmountConfirmation(amount, candidates) {
  const formatted = amount.toFixed(2).replace(".", ",");
  const others = candidates.filter((c) => c.value !== amount).map((c) => c.raw);
  const othersPart = others.length > 0 ? ` (não R$ ${others.join(", ")})` : "";
  return `Entendi o valor R$ ${formatted}${othersPart}. Confirma? (sim/não)`;
}
