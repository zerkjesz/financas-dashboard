// ============================================================================
// Fase 9.1 — READ-MODEL da HOME v4. SOMENTE LEITURA. Compõe o snapshot canônico (motor
// financeiro: caixa, comprometido, livre, seguro), o modelo de Compromissos (mês corrente) e as
// últimas movimentações reais. Nenhum número é hardcoded — nem o nome do usuário, nem o mês, nem
// os dias até a renda.
// ============================================================================
import { prisma } from "./prisma.js";
import { serializeMoney } from "./money.js";
import { buildProductFinancialSnapshot } from "./productFinancialSnapshot.js";
import { buildCommitmentsModel } from "./compromissosModel.js";
import { listAccountsWithBalances } from "./accounts.js";
import { getAppTimezone, localCalendarDateAsUtcMidnight } from "./appTimezone.js";
import { monthLongName } from "./paymentDates.js";

const num = (x) => (x == null ? null : Number(serializeMoney(x)));
const round2 = (n) => Math.round(n * 100) / 100;
const LONG_MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

// Copy do hero por estado do motor (o motor decide o estado; aqui só a frase).
export const HERO_HEADLINE = Object.freeze({
  TRANQUILO: (committed) => (committed > 0 ? "Seu dinheiro está sob controle, mas parte dele já tem destino." : "Seu dinheiro está sob controle."),
  ATENCAO: () => "Está tudo pago, mas a margem até a renda está curta.",
  APERTADO: () => "O que está comprometido quase cobre o que você tem.",
  CRITICO: () => "O que está comprometido passa do que você tem agora.",
});
export const HERO_STATUS_LABEL = Object.freeze({ TRANQUILO: "Tranquilo", ATENCAO: "Atenção", APERTADO: "Apertado", CRITICO: "Crítico" });

function greeting(now, tz) {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(now));
  return h < 5 ? "Boa madrugada" : h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

export async function buildHomeModel({ now = new Date(), client = prisma } = {}) {
  const tz = getAppTimezone();
  const today = localCalendarDateAsUtcMidnight(now, tz);
  const [snapshot, comp, accounts] = await Promise.all([buildProductFinancialSnapshot({ client, now }), buildCommitmentsModel({ client, now }), listAccountsWithBalances({ client })]);

  const cash = num(snapshot.liquidity.unrestrictedCash);
  const free = num(snapshot.liquidity.freeMoney);
  const safe = num(snapshot.liquidity.safeToSpend);
  const protectedMoney = num(snapshot.liquidity.protectedMoney) ?? 0;
  const committedTotal = round2(num(snapshot.currentObligations.incurredLiabilities) + num(snapshot.currentObligations.dueBeforeNextIncome));
  const status = snapshot.liquidity.status;

  // ---- componentes do "comprometido" (vindos do motor, agrupados por natureza)
  const parts = [];
  let houseTotal = 0;
  for (const item of snapshot.currentObligations.breakdown) {
    const amount = num(item.amount);
    if (!amount) continue;
    if (item.type === "Bill" && item.houseBill) {
      // Competência corrente => UMA linha "Contas da casa"; outra competência que vence antes da próxima
      // renda (ex.: aluguel de 05/10) => linha PRÓPRIA e localizável (nada escondido em "outros").
      if (!item.beforeNextIncome) { houseTotal = round2(houseTotal + amount); continue; }
      const d = item.dueDate ? new Date(item.dueDate) : null;
      const dm = d ? `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}` : "";
      parts.push({ kind: "casa", label: `${item.description}${dm ? `, vence ${dm}` : ""}`, short: `${item.description}${dm ? ` ${dm}` : ""}`, amount, funded: false, beforeNextIncome: true });
      continue;
    }
    if (item.type === "CardBill") parts.push({ kind: "fatura", label: `Fatura ${item.cardName}`, short: "Fatura", amount, funded: false });
    else if (item.type === "ConfirmedCommitment") parts.push({ kind: item.status === "FUNDED" ? "funded" : "commitment", label: item.description, short: item.shortLabel || item.description, amount, funded: item.status === "FUNDED" });
    else if (item.type === "Bill") parts.push({ kind: "conta", label: item.description, short: item.description, amount, funded: false });
    else if (item.type === "ExternalInstallment") parts.push({ kind: "parcela", label: `${item.planDescription} (parcela ${item.number})`, short: item.planDescription, amount, funded: false });
    else parts.push({ kind: "outro", label: item.description || item.type, short: item.description || item.type, amount, funded: false });
  }
  if (houseTotal > 0) {
    const at = parts.findIndex((p) => p.beforeNextIncome); // "Contas da casa" (mês corrente) vem antes das que vencem em outra competência
    parts.splice(at < 0 ? parts.length : at, 0, { kind: "casa", label: "Contas da casa", short: "Casa", amount: houseTotal, funded: false });
  }
  // Contas variáveis SEM valor conhecido: nunca viram zero — a Home diz que o seguro foi calculado sem elas.
  const unpriced = snapshot.houseBills?.unpricedPendingBills ?? [];
  const unpricedBills = { count: unpriced.length, names: unpriced.map((b) => b.name), text: unpriced.length === 0 ? null : unpriced.length === 1 ? `Seguro calculado sem 1 conta ainda sem valor: ${unpriced[0].name}.` : `Seguro calculado sem ${unpriced.length} contas ainda sem valor: ${unpriced.map((b) => b.name).join(", ")}.` };
  const unrestrictedAccounts = accounts.filter((a) => a.type === "checking" || a.type === "cash").map((a) => ({ name: a.name, balance: num(a.balance) })).filter((a) => a.balance !== 0);

  // ---- dias até a renda
  const nextDate = snapshot.nextIncome.expectedDate ? localCalendarDateAsUtcMidnight(new Date(snapshot.nextIncome.expectedDate), "UTC") : null;
  const daysLeft = nextDate ? Math.max(1, Math.round((nextDate.getTime() - today.getTime()) / 86400000)) : null;
  const perDay = daysLeft && safe > 0 ? Math.floor(safe / daysLeft) : null;
  const nextIncomeLabel = nextDate ? `${nextDate.getUTCDate()} de ${LONG_MONTHS[nextDate.getUTCMonth()]}` : null;

  // ---- atenção agora (só o que pede ação)
  const attention = [];
  for (const p of parts.filter((x) => x.kind === "fatura")) attention.push({ id: `att:fatura`, kind: "fatura", name: p.label, sub: "Fatura atual do cartão", value: p.amount, valueLabel: null, cta: "Ver fatura", href: "/cartoes", tone: "neutral" });
  const pendParcelas = comp.items.filter((i) => i.kind === "parcela" && i.state === "pending");
  if (pendParcelas.length) {
    const names = pendParcelas.slice(0, 2).map((i) => i.name);
    attention.push({ id: "att:parcelas", kind: "parcelas", name: pendParcelas.length === 1 ? "1 parcela para pagar" : `${pendParcelas.length} parcelas para pagar`, sub: names.length > 1 ? `${names[0]} e ${names[1]}` + (pendParcelas.length > 2 ? ` e mais ${pendParcelas.length - 2}` : "") : names[0], value: round2(pendParcelas.reduce((a, i) => a + i.value, 0)), valueLabel: null, cta: "Pagar", href: "/compromissos?tab=mes", tone: "primary" });
  }
  const pendCasa = comp.items.filter((i) => i.kind === "casa" && i.state === "pending");
  if (pendCasa.length) {
    attention.push({ id: "att:casa", kind: "casa", name: "Contas da casa", sub: [...pendCasa].sort((a, b) => Number(b.awaitingValue) - Number(a.awaitingValue)).slice(0, 3).map((i) => (i.awaitingValue ? `${i.name} aguardando valor` : i.name)).join(" · ") + (pendCasa.length > 3 ? ` e mais ${pendCasa.length - 3}` : ""), value: null, valueLabel: pendCasa.length === 1 ? "1 pendente" : `${pendCasa.length} pendentes`, cta: "Ver", href: "/compromissos?tab=casa", tone: "neutral" });
  }
  const pendComp = comp.items.filter((i) => i.kind === "compromisso" && i.state === "pending");
  for (const c of pendComp) attention.push({ id: `att:${c.id}`, kind: "compromisso", name: c.name, sub: c.overdue ? "Atrasado" : c.compromisso.dueDate ? "Compromisso confirmado" : "Sem prazo definido", value: c.value, valueLabel: null, cta: "Ver", href: "/compromissos?tab=mes", tone: "neutral" });
  for (const f of comp.funded) attention.push({ id: `att:${f.id}`, kind: "funded", name: f.shortLabel ? `Devolver ao ${f.shortLabel}` : f.description, sub: f.dueDate ? "Dinheiro separado" : "Dinheiro separado · sem prazo definido", value: f.amount, valueLabel: null, cta: "Detalhes", href: "/compromissos?tab=mes", tone: "neutral" });

  // ---- casa (resumo pequeno)
  const casaItems = comp.items.filter((i) => i.kind === "casa");
  const casaRows = [...casaItems.filter((i) => i.state === "done").slice(0, 1), ...casaItems.filter((i) => i.state === "pending")].slice(0, 3).map((i) => ({
    name: i.name,
    done: i.state === "done",
    status: i.state === "done" ? "Paga" : i.awaitingValue ? "Aguardando valor" : i.casa.partsTotal > 1 && i.casa.partsPaid > 0 ? `${i.casa.partsPaid + 1}ª visita pendente` : i.overdue ? "Atrasada" : "Pendente",
    tone: i.state === "done" ? "ink" : i.awaitingValue ? "warning" : "muted",
  }));

  // ---- próximo alívio
  const relief = comp.relief;
  let nextRelief = null;
  if (relief.next) {
    const withinThree = relief.milestones.filter((m) => relief.months.findIndex((mm) => mm.monthKey === m.monthKey) <= 3);
    const extra = round2(withinThree.reduce((a, m) => a + m.released, 0));
    const horizonMonth = relief.months[Math.min(3, relief.months.length - 1)];
    nextRelief = {
      monthLong: relief.next.monthLong,
      released: relief.next.released,
      names: relief.next.plans.map((p) => p.name),
      after: relief.next.after,
      untilLabel: horizonMonth ? monthLongName(horizonMonth.monthKey).toLowerCase() : null,
      untilReleased: extra,
    };
  }

  // ---- últimas movimentações (5, reais)
  const [exp, inc, trf] = await Promise.all([
    client.expense.findMany({ orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }], take: 5, include: { account: true, card: true } }),
    client.income.findMany({ orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }], take: 5, include: { account: true } }),
    client.transfer.findMany({ orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }], take: 5, include: { fromAccount: true, toAccount: true } }),
  ]);
  const moves = [
    ...exp.map((e) => ({ at: e.occurredAt, created: e.createdAt, name: e.description, sub: `${e.category} · ${e.card ? `Cartão ${e.card.name}` : e.account?.name ?? "—"}`, amount: -num(e.amount), type: "expense" })),
    ...inc.map((i) => ({ at: i.occurredAt, created: i.createdAt, name: i.description, sub: `${i.category} · ${i.account.name}`, amount: num(i.amount), type: "income" })),
    ...trf.map((t) => ({ at: t.occurredAt, created: t.createdAt, name: t.description, sub: `Transferência · ${t.fromAccount?.name ?? "fora do Norte"} → ${t.toAccount?.name ?? "fora do Norte"}`, amount: num(t.amount), type: "transfer" })),
  ]
    .sort((a, b) => b.at - a.at || b.created - a.created)
    .slice(0, 5)
    .map((m) => ({ date: `${String(m.at.getUTCDate()).padStart(2, "0")}/${String(m.at.getUTCMonth() + 1).padStart(2, "0")}`, name: m.name, sub: m.sub, amount: m.amount, type: m.type }));

  return {
    generatedAt: now.toISOString(),
    greeting: greeting(now, tz),
    dateLabel: `${WEEKDAYS[today.getUTCDay()]}, ${today.getUTCDate()} de ${LONG_MONTHS[today.getUTCMonth()]}`,
    dateLabelShort: `${WEEKDAYS[today.getUTCDay()].slice(0, 3)}, ${today.getUTCDate()} ${LONG_MONTHS[today.getUTCMonth()].slice(0, 3)}`,
    hero: {
      status,
      statusLabel: HERO_STATUS_LABEL[status] ?? "Atenção",
      headline: (HERO_HEADLINE[status] ?? HERO_HEADLINE.ATENCAO)(committedTotal),
      safe,
      free,
      cash,
      committed: committedTotal,
      protectedMoney,
      safetyReserve: free > 0 ? round2(free - safe) : 0,
      cashParts: unrestrictedAccounts,
      committedParts: parts,
      unpricedBills,
      vaBalance: snapshot.restricted ? num(snapshot.restricted.vaBalance) : null,
      daysLeft,
      perDay,
      nextIncomeLabel,
      nextIncomeAmount: num(snapshot.nextIncome.baseAmount),
      nextIncomeIsFallback: !!snapshot.nextIncome.isFallback,
    },
    attention,
    compromissos: { monthLong: comp.monthLong, resolved: comp.summary.resolved, total: comp.summary.total, paidAmount: comp.summary.paidAmount, pendingAmount: comp.summary.pendingAmount, awaitingValueCount: comp.summary.awaitingValueCount },
    casa: { resolved: comp.summary.casaResolved, total: comp.summary.casaCount, rows: casaRows },
    relief: nextRelief,
    nextIncomeCommitment: { committedAmount: num(snapshot.nextIncomeCommitment.committedAmount), percent: snapshot.nextIncomeCommitment.baseCommittedPercent == null ? null : Number(snapshot.nextIncomeCommitment.baseCommittedPercent) },
    moves,
  };
}
