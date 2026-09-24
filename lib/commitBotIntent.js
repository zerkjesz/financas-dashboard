import { prisma } from "./prisma.js";
import { formatMoney, formatDate } from "./formatMoney.js";
import { generateInstallmentSchedule } from "./installments.js";
import { resolveCurrentBillSafely, payBill, anticipateBill } from "./cardBillCalculator.js";
import { getDefaultCard, getDefaultAccount, resolveMentionedAccounts } from "./accountResolver.js";
import { createBill, markBillPaid } from "./bills.js";
import { addToGoal, updateGoalTargetAmount } from "./goals.js";
import { normalize } from "./categoryRules.js";
import { money, subtractMoney, divideMoney, maxMoney, roundMoney, serializeMoney, ZERO } from "./money.js";
import { resolveConfidence } from "./dataConfidence.js";
import { getCardCycleForDate } from "./cardCycle.js";
import { createCommitment, settleCommitmentCreatingExpense, updateCommitmentDetails } from "./commitments.js";
import { createContingency, updateContingencyStatus, updateContingencyAmount } from "./contingencies.js";
import { createReceivable, markReceivableReceived, updateReceivableDetails } from "./receivables.js";

// Recebe um intent já classificado (e, se preciso, já confirmado pelo usuário) e grava o
// registro certo no banco, retornando a mensagem de resposta do bot.
//
// Decimal-first, fronteira de entrada (Fase 3.1, Etapa 8): `data.amount` chega como
// number puro (extraído de texto livre pelo parser) — cada commit* converte pra
// money() assim que entra no domínio financeiro, antes de qualquer conta ou escrita.
//
// Fase 5.3C.2 — `client` opcional (default: `prisma`), mesmo padrão aditivo já
// usado no resto do projeto: permite injetar `{ client: tx }` a partir de
// lib/telegramUpdateHandler.js, pra que TODA mutação disparada por um único
// update do Telegram (claim do receipt + esta mutação + marcar completo)
// aconteça numa ÚNICA transação Prisma — ou tudo persiste, ou nada persiste.
// Nenhum call-site existente (rotas de API, scripts) muda de comportamento.
export async function commitBotIntent(intent, data, { source = "telegram", client = prisma } = {}) {
  switch (intent) {
    case "income":
      return commitIncome(data, source, client);
    case "expense":
      return commitExpense(data, source, client);
    case "installment_purchase":
      return commitInstallmentPurchase(data, source, client);
    case "bill_payment":
      return commitBillPayment(data, source, client);
    case "limit_update":
      return commitLimitUpdate(data, source, client);
    case "balance_adjustment":
      return commitBalanceAdjustment(data, source, client);
    case "transfer":
      return commitTransfer(data, source, client);
    case "create_bill":
      return commitCreateBill(data, source, client);
    case "pay_bill":
      return commitPayBill(data, source, client);
    case "create_account":
      return commitCreateAccount(data, source, client);
    case "create_card":
      return commitCreateCard(data, source, client);
    case "create_recurring_bill":
      return commitCreateRecurringBill(data, source, client);
    case "create_goal":
      return commitCreateGoal(data, source, client);
    case "add_to_goal":
      return commitAddToGoal(data, source, client);
    case "update_goal":
      return commitUpdateGoal(data, source, client);
    // Fase 7D — Telegram determinístico/menu-driven: estes intents espelham
    // 1:1 os serviços de domínio já usados pelo pipeline conversacional
    // (lib/telegramAi/planExecutor.js) — chamados AQUI diretamente com dados
    // já coletados pelo wizard (nunca via plano/LLM), mesma lógica financeira,
    // nenhuma duplicada.
    case "create_confirmed_commitment":
      return commitCreateConfirmedCommitment(data, source, client);
    case "settle_confirmed_commitment":
      return commitSettleConfirmedCommitment(data, source, client);
    case "update_confirmed_commitment":
      return commitUpdateConfirmedCommitment(data, source, client);
    case "update_contingency":
      return commitUpdateContingency(data, source, client);
    case "create_contingency":
      return commitCreateContingency(data, source, client);
    case "resolve_contingency":
      return commitResolveContingency(data, source, client);
    case "create_receivable":
      return commitCreateReceivable(data, source, client);
    case "mark_receivable_received":
      return commitMarkReceivableReceived(data, source, client);
    case "update_receivable":
      return commitUpdateReceivable(data, source, client);
    default:
      throw new Error(`Intent desconhecido: ${intent}`);
  }
}

async function commitIncome(data, source, client) {
  const account = data.target?.type === "account" ? data.target.account : await getDefaultAccount({ client });
  const amount = money(data.amount);
  const income = await client.income.create({
    data: {
      amount,
      description: data.description,
      category: data.category,
      accountId: account.id,
      isRecurring: data.isRecurring,
      source,
      // Fase 3.2: nunca inventa ESTIMATED por ser áudio/texto — só respeita um
      // valor explícito em `data.confidence` (nenhum parser seta isso hoje); sem
      // isso, cai no default (CONFIRMED).
      confidence: resolveConfidence(data.confidence),
      rawMessage: data.rawMessage,
      // Fase 5.3D — data ECONÔMICA (lib/naturalDate.js:resolveEconomicDate),
      // nunca a data de ingestão da mensagem. `data.occurredAt` já vem
      // resolvido por parseTransaction.js; ausência (ex: chamada fora do bot)
      // cai no @default(now()) do schema.
      ...(data.occurredAt ? { occurredAt: data.occurredAt } : {}),
    },
  });
  return { record: income, reply: `✅ Receita registrada: +${formatMoney(data.amount)} (${data.category}) em ${account.name}${data.isRecurring ? " 🔁 fixo" : ""}` };
}

async function commitExpense(data, source, client) {
  const target = data.target?.type ? data.target : { type: "account", account: await getDefaultAccount({ client }) };
  const amount = money(data.amount);
  const expense = await client.expense.create({
    data: {
      amount,
      description: data.description,
      category: data.category,
      accountId: target.type === "account" ? target.account.id : null,
      cardId: target.type === "card" ? target.card.id : null,
      isRecurring: data.isRecurring,
      source,
      confidence: resolveConfidence(data.confidence),
      rawMessage: data.rawMessage,
      ...(data.occurredAt ? { occurredAt: data.occurredAt } : {}),
    },
  });
  const targetName = target.type === "card" ? `cartão ${target.card.name}` : target.account.name;
  return { record: expense, reply: `✅ Gasto registrado: -${formatMoney(data.amount)} (${data.category}) via ${targetName}${data.isRecurring ? " 🔁 fixo" : ""}` };
}

async function commitInstallmentPurchase(data, source, client) {
  const card = data.target?.type === "card" ? data.target.card : await getDefaultCard({ client });
  const count = data.installmentCount;
  const totalAmount = money(data.amount);
  // Mesmo cálculo de lib/installments.js (última parcela absorve a sobra) — aqui é só
  // pra mostrar a parcela na mensagem de confirmação; o schedule de verdade é gerado
  // por generateInstallmentSchedule logo abaixo, com a mesma lógica.
  const installmentValue = roundMoney(divideMoney(totalAmount, count));
  // Fase 4.0: ciclo real DESTE cartão (closingDay-aware) — idêntico ao valor
  // antigo enquanto closingDay continuar null. Fase 5.3D, item 25 — usa a
  // data ECONÔMICA da compra (data.occurredAt, resolvida por
  // parseTransaction.js), nunca `new Date()` incondicional: uma compra
  // relatada como retrospectiva ("comprei ontem, parcelei em 5x") precisa
  // cair no ciclo/mês que CONTÉM aquele dia, não o de hoje — isso pode
  // importar perto de uma virada de fechamento de fatura.
  const purchasedAt = data.occurredAt || new Date();
  const firstInstallmentMonth = getCardCycleForDate(card, purchasedAt);

  const purchase = await client.purchase.create({
    data: {
      description: data.description,
      totalAmount,
      installmentCount: count,
      installmentValue,
      category: data.category,
      cardId: card.id,
      firstInstallmentMonth,
      source,
      confidence: resolveConfidence(data.confidence),
      rawMessage: data.rawMessage,
      purchasedAt,
    },
  });
  await generateInstallmentSchedule(purchase, { client });

  return {
    record: purchase,
    reply: `✅ Compra parcelada registrada: ${formatMoney(data.amount)} em ${count}x de ${formatMoney(serializeMoney(installmentValue))} no cartão ${card.name}, a partir de ${firstInstallmentMonth}.`,
  };
}

async function commitBillPayment(data, source, client) {
  const card = data.target?.type === "card" ? data.target.card : await getDefaultCard({ client });
  // Fase 7D.1 — o wizard "Pagar fatura" já escolheu a conta por botão; sem
  // fromAccountId mantém o comportamento antigo (conta padrão).
  const fromAccount = data.fromAccountId ? await client.account.findUnique({ where: { id: data.fromAccountId } }) : await getDefaultAccount({ client });
  if (!fromAccount) throw new Error(`Conta de origem não encontrada: ${data.fromAccountId}`);

  // resolveCurrentBillSafely nunca cria uma fatura com cycleMonth adivinhado quando o
  // ciclo real do cartão (closingDay) não bate com mês calendário — se não conseguir
  // resolver com segurança, prefere avisar o usuário a vincular a antecipação/pagamento
  // à fatura errada (Norte v2, Fase 1.1).
  let bill;
  try {
    bill = await resolveCurrentBillSafely(card.id, { client });
  } catch (err) {
    return { record: null, reply: `⚠️ ${err.message}` };
  }

  // Item 26 — pagamento/antecipação retrospectivo usa a data econômica
  // resolvida (data.occurredAt), nunca `now()` incondicional. Não altera o
  // estado authoritative da CardBill em si (status/paidAmount continuam
  // derivados normalmente por payBill/anticipateBill) — só QUANDO o Transfer
  // aconteceu de verdade.
  if (data.billPaymentKind === "installment_anticipation") {
    const transfer = await anticipateBill(bill.id, {
      fromAccountId: fromAccount.id,
      amount: data.amount,
      description: data.description,
      source,
      confidence: data.confidence,
      rawMessage: data.rawMessage,
      occurredAt: data.occurredAt,
    }, { client });
    return {
      record: transfer,
      reply: `✅ Antecipação registrada: ${formatMoney(data.amount)} no cartão ${card.name}, debitado de ${fromAccount.name}. Isso reduz o limite usado sem quitar a fatura inteira.`,
    };
  }

  const { transfer } = await payBill(bill.id, {
    fromAccountId: fromAccount.id,
    amount: data.amount,
    description: data.description,
    source,
    confidence: data.confidence,
    rawMessage: data.rawMessage,
    occurredAt: data.occurredAt,
  }, { client });
  return {
    record: transfer,
    reply: `✅ Pagamento de fatura registrado: ${formatMoney(data.amount)} do cartão ${card.name}, debitado de ${fromAccount.name}.`,
  };
}

async function commitLimitUpdate(data, source, client) {
  const card = data.target?.type === "card" ? data.target.card : await getDefaultCard({ client });
  const reportedAvailable = money(data.amount);
  const newUsedLimit = maxMoney(ZERO, subtractMoney(card.totalLimit, reportedAvailable));
  const limitUpdate = await client.cardLimitUpdate.create({
    data: {
      cardId: card.id,
      newUsedLimit,
      reportedAvailable,
      source,
      confidence: resolveConfidence(data.confidence),
      rawMessage: data.rawMessage,
    },
  });
  return {
    record: limitUpdate,
    reply: `✅ Limite do cartão ${card.name} atualizado: ${formatMoney(data.amount)} disponíveis. Isso não afeta receitas nem gastos.`,
  };
}

async function commitBalanceAdjustment(data, source, client) {
  const account = data.target?.type === "account" ? data.target.account : await getDefaultAccount({ client });
  const adjustment = await client.balanceAdjustment.create({
    data: {
      accountId: account.id,
      newBalance: money(data.amount),
      source,
      confidence: resolveConfidence(data.confidence),
      rawMessage: data.rawMessage,
    },
  });
  return {
    record: adjustment,
    reply: `✅ Saldo da conta ${account.name} atualizado para ${formatMoney(data.amount)}.`,
  };
}

async function commitTransfer(data, source, client) {
  // Fase 7D — o wizard determinístico já resolveu origem/destino por botão
  // (nunca por menção em texto livre); quando presentes, usa EXATAMENTE
  // esses IDs, sem rodar resolveMentionedAccounts (que é pro caminho de
  // texto livre legado e não se aplica aqui — nunca duplica a resolução).
  let fromAccount;
  let toAccount;
  if (data.fromAccountId && data.toAccountId) {
    [fromAccount, toAccount] = await Promise.all([
      client.account.findUnique({ where: { id: data.fromAccountId } }),
      client.account.findUnique({ where: { id: data.toAccountId } }),
    ]);
    // Fase 7D.1 — achado real de teste: um accountId explícito que não
    // resolve (conta apagada entre o preview e a confirmação, id
    // corrompido, etc.) NUNCA deve virar uma Transfer com fromAccountId/
    // toAccountId nulo silenciosamente — origem e destino são obrigatórios
    // (item 10/6 do pedido). Falha alto e claro em vez de gravar dado
    // incompleto.
    if (!fromAccount) throw new Error(`Conta de origem não encontrada: ${data.fromAccountId}`);
    if (!toAccount) throw new Error(`Conta de destino não encontrada: ${data.toAccountId}`);
  } else {
    const mentioned = await resolveMentionedAccounts(data.rawMessage, { client });
    if (mentioned.length >= 2) {
      [fromAccount, toAccount] = mentioned;
    } else if (mentioned.length === 1) {
      toAccount = mentioned[0];
      fromAccount = await getDefaultAccount({ client });
      if (fromAccount.id === toAccount.id) fromAccount = null;
    } else {
      fromAccount = await getDefaultAccount({ client });
    }
  }

  const transfer = await client.transfer.create({
    data: {
      amount: money(data.amount),
      description: data.description,
      fromAccountId: fromAccount?.id ?? null,
      toAccountId: toAccount?.id ?? null,
      kind: "generic",
      source,
      confidence: resolveConfidence(data.confidence),
      rawMessage: data.rawMessage,
      // Item 28 — 1 única row representa os 2 lados: a data econômica é
      // necessariamente a MESMA pros dois, por construção (nunca pode
      // divergir, não existem 2 writes separadas).
      ...(data.occurredAt ? { occurredAt: data.occurredAt } : {}),
    },
  });
  const fromName = fromAccount?.name ?? "?";
  const toName = toAccount?.name ?? "?";
  return { record: transfer, reply: `✅ Transferência registrada: ${formatMoney(data.amount)} de ${fromName} para ${toName}.` };
}

async function commitCreateBill(data, source, client) {
  const account = data.target?.type === "account" ? data.target.account : null;
  const bill = await createBill({
    description: data.description,
    amount: money(data.amount),
    category: data.category,
    accountId: account?.id,
    dueDate: new Date(data.dueDate),
    source,
    confidence: data.confidence,
    rawMessage: data.rawMessage,
  }, { client });
  return {
    record: bill,
    reply: `✅ Conta a pagar criada: "${bill.description}" — ${formatMoney(serializeMoney(bill.amount))}, vence em ${formatDate(bill.dueDate)}.`,
  };
}

async function commitPayBill(data, source, client) {
  if (!data.billId) {
    // Fallback quando nenhuma conta pendente foi encontrada e o usuário escolheu "criar e já marcar paga".
    const account = data.target?.type === "account" ? data.target.account : await getDefaultAccount({ client });
    const bill = await createBill({
      description: data.description,
      amount: money(data.amount),
      category: data.category,
      accountId: account.id,
      dueDate: new Date(),
      source,
      confidence: data.confidence,
      rawMessage: data.rawMessage,
    }, { client });
    const { expense } = await markBillPaid(bill.id, { accountId: account.id, description: data.description, confidence: data.confidence, occurredAt: data.occurredAt }, { client });
    return { record: expense, reply: `✅ Conta "${bill.description}" criada e marcada como paga: ${formatMoney(data.amount)}.` };
  }

  const account = data.target?.type === "account" ? data.target.account : undefined;
  const { expense, bill } = await markBillPaid(data.billId, {
    accountId: account?.id,
    description: data.description,
    confidence: data.confidence,
    occurredAt: data.occurredAt,
  }, { client });
  return { record: expense, reply: `✅ Conta "${bill.description}" marcada como paga: ${formatMoney(serializeMoney(expense.amount))}.` };
}

function slugify(text) {
  return normalize(text).replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "item";
}

async function uniqueSlug(client, model, name) {
  const base = slugify(name);
  let slug = base;
  let i = 2;
  while (await client[model].findUnique({ where: { slug } })) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

async function commitCreateAccount(data, source, client) {
  const slug = await uniqueSlug(client, "account", data.accountName);
  const account = await client.account.create({ data: { slug, name: data.accountName, type: "checking" } });
  return { record: account, reply: `✅ Conta "${account.name}" criada. Se for vale-alimentação ou dinheiro em vez de conta corrente, ajusta o tipo dela na tela de Cartões/Contas do site.` };
}

async function commitCreateCard(data, source, client) {
  const slug = await uniqueSlug(client, "card", data.cardName);
  const card = await client.card.create({
    data: {
      slug,
      name: data.cardName,
      totalLimit: money(data.totalLimit),
      closingDay: data.closingDay ?? null,
      dueDay: data.dueDay,
    },
  });
  return {
    record: card,
    reply: `✅ Cartão "${card.name}" criado: limite ${formatMoney(serializeMoney(card.totalLimit))}, vencimento dia ${card.dueDay}${card.closingDay ? `, fechamento dia ${card.closingDay}` : ""}.`,
  };
}

async function commitCreateRecurringBill(data, source, client) {
  const rule = await client.recurringRule.create({
    data: {
      name: data.recurringName,
      kind: "expense",
      amount: money(data.recurringAmount),
      dayOfMonth: data.dayOfMonth,
      category: data.category,
    },
  });
  return {
    record: rule,
    reply: `✅ Conta recorrente "${rule.name}" criada: ${formatMoney(serializeMoney(rule.amount))} todo dia ${rule.dayOfMonth}. Ela já vai aparecer nas próximas obrigações e no fluxo de caixa.`,
  };
}

async function commitCreateGoal(data, source, client) {
  const goal = await client.goal.create({ data: { name: data.goalName, targetAmount: money(data.targetAmount) } });
  return { record: goal, reply: `✅ Meta "${goal.name}" criada: guardar ${formatMoney(serializeMoney(goal.targetAmount))}.` };
}

async function commitAddToGoal(data, source, client) {
  if (!data.goalId) {
    return { record: null, reply: `Não achei nenhuma meta com esse nome. Confere o nome ou cria a meta primeiro ("criar meta: guardar X pra Y").` };
  }
  const goal = await addToGoal(data.goalId, data.amount, { client });
  return { record: goal, reply: `✅ Guardado mais ${formatMoney(data.amount)} pra meta "${goal.name}". Total: ${formatMoney(serializeMoney(goal.savedAmount))}.` };
}

async function commitUpdateGoal(data, source, client) {
  const goal = await updateGoalTargetAmount(data.goalId, data.targetAmount, { client });
  return { record: goal, reply: `✅ Meta "${goal.name}" atualizada: guardar ${formatMoney(serializeMoney(goal.targetAmount))}.` };
}

// ============================== Fase 7D: planejamento ==============================

async function commitCreateConfirmedCommitment(data, source, client) {
  const commitment = await createCommitment(
    { description: data.description, amount: data.amount, dueDate: data.dueDate, notes: data.notes, confidence: data.confidence },
    { client }
  );
  return { record: commitment, reply: `✅ Compromisso confirmado: "${commitment.description}" — ${formatMoney(serializeMoney(commitment.amount))}, vence em ${formatDate(commitment.dueDate)}.` };
}

async function commitSettleConfirmedCommitment(data, source, client) {
  const account = data.target?.type === "account" ? data.target.account : await getDefaultAccount({ client });
  const { commitment, expense } = await settleCommitmentCreatingExpense(
    data.commitmentId,
    { accountId: account.id, description: data.description, category: data.category, occurredAt: data.occurredAt, confidence: data.confidence },
    { client }
  );
  return { record: { commitment, expense }, reply: `✅ Compromisso "${commitment.description}" marcado como pago: ${formatMoney(serializeMoney(expense.amount))} via ${account.name}.` };
}

// Fase 7D.1 — updateCommitmentDetails já bloqueia SETTLED/CANCELLED (nunca
// colapsa FUNDED->SETTLED por engano: editar um FUNDED continua permitido,
// virar SETTLED só acontece via commitSettleConfirmedCommitment de verdade).
async function commitUpdateConfirmedCommitment(data, source, client) {
  const updated = await updateCommitmentDetails(data.commitmentId, { amount: data.amount, dueDate: data.dueDate }, { client });
  return { record: updated, reply: `✅ Compromisso "${updated.description}" atualizado: ${formatMoney(serializeMoney(updated.amount))}, vence em ${formatDate(updated.dueDate)}.` };
}

async function commitCreateContingency(data, source, client) {
  const contingency = await createContingency(
    { description: data.description, expectedAmount: data.expectedAmount, maxAmount: data.maxAmount, expectedDate: data.expectedDate, notes: data.notes, confidence: data.confidence },
    { client }
  );
  return { record: contingency, reply: `✅ Contingência registrada: "${contingency.description}" — até ${formatMoney(serializeMoney(contingency.maxAmount))}.` };
}

// Item 3 do pedido — o domínio (lib/contingencies.js) só suporta atualizar
// maxAmount (nunca expectedAmount/expectedDate/notes — nenhuma função de
// serviço existe pra esses campos). Editar contingência fica limitado a
// isso de propósito, nunca um Prisma update cru pros campos sem serviço.
async function commitUpdateContingency(data, source, client) {
  const updated = await updateContingencyAmount(data.contingencyId, data.maxAmount, { client });
  return { record: updated, reply: `✅ Contingência "${updated.description}" atualizada: até ${formatMoney(serializeMoney(updated.maxAmount))}.` };
}

async function commitResolveContingency(data, source, client) {
  const contingency = await updateContingencyStatus(data.contingencyId, data.status, { client });
  const humanStatus = data.status === "CONFIRMED" ? "confirmada (virou real)" : data.status === "DISMISSED" ? "descartada" : contingency.status;
  return { record: contingency, reply: `✅ Contingência "${contingency.description}" ${humanStatus}.` };
}

async function commitCreateReceivable(data, source, client) {
  const receivable = await createReceivable(
    { description: data.description, counterparty: data.counterparty, amount: data.amount, expectedDate: data.expectedDate, notes: data.notes, confidence: data.confidence },
    { client }
  );
  return { record: receivable, reply: `✅ Valor a receber registrado: ${formatMoney(serializeMoney(receivable.amount))} de ${receivable.counterparty}.` };
}

async function commitMarkReceivableReceived(data, source, client) {
  const account = data.target?.type === "account" ? data.target.account : await getDefaultAccount({ client });
  const { receivable, income } = await markReceivableReceived(data.receivableId, { accountId: account.id, occurredAt: data.occurredAt, description: data.description, category: data.category, confidence: data.confidence, client });
  return { record: { receivable, income }, reply: `✅ Recebido: ${formatMoney(serializeMoney(income.amount))} de ${receivable.counterparty}, creditado em ${account.name}.` };
}

async function commitUpdateReceivable(data, source, client) {
  const updated = await updateReceivableDetails(data.receivableId, { amount: data.amount, expectedDate: data.expectedDate }, { client });
  return { record: updated, reply: `✅ Valor a receber "${updated.description}" atualizado: ${formatMoney(serializeMoney(updated.amount))} de ${updated.counterparty}.` };
}
