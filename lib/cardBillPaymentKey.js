// Fase 10.5 — identidade e conciliação do PAGAMENTO DA FATURA (módulo LEVE, sem banco): usado pelo fluxo "Marcar fatura como paga"
// (lib/cardBillPayment.js) e pelo import do Data Hub (lib/dataHub/adapters.js) — uma única definição da chave e da regra de matching.
//
// CHAVE do pagamento (Transfer.rawMessage):  CARD_BILL_PAYMENT|v1|bill=<id>|cycle=<AAAA-MM>|amount=<valor>|acct=<id>|day=<AAAA-MM-DD>
// Depois de conciliado com o extrato:        …|bank=<referência da linha bancária>|bankDay=<AAAA-MM-DD>
//
// MATCHING de uma linha bancária com um pagamento já registrado: mesma conta de origem + valor exato + data dentro da janela
// (padrão ±5 dias: o banco lança no dia útil seguinte) + pagamento ainda NÃO conciliado. Exatamente 1 candidato => concilia;
// 2+ candidatos => AMBÍGUO (nunca escolhe: vai para revisão); 0 => não é este pagamento.
import { money } from "./money.js";

export const PAYMENT_KEY_PREFIX = "CARD_BILL_PAYMENT|v1|";
export const PAYMENT_MATCH_TOLERANCE_DAYS = 5;
const DAY_MS = 86400000;

export const paymentKey = ({ billId, cycleMonth, amount, accountId, day }) => `${PAYMENT_KEY_PREFIX}bill=${billId}|cycle=${cycleMonth}|amount=${money(amount).toFixed(2)}|acct=${accountId}|day=${day}`;
export const isFlowPayment = (transfer) => transfer?.kind === "card_bill_payment" && String(transfer.rawMessage ?? "").startsWith(PAYMENT_KEY_PREFIX);
export const isBankReconciled = (transfer) => /\|bank=/.test(transfer?.rawMessage ?? "");
export const bankReferenceOf = (transfer) => (/\|bank=([^|]*)/.exec(transfer?.rawMessage ?? "") ?? [])[1] ?? null;
export const sanitizeReference = (ref) => String(ref).replace(/\|/g, "/").trim();
export const withBankReference = (rawMessage, reference, day) => `${rawMessage}|bank=${sanitizeReference(reference)}|bankDay=${day}`;
export const dayStart = (s) => new Date(`${s}T00:00:00.000Z`);
export const dayKey = (d) => d.toISOString().slice(0, 10);

// Janela de busca no banco: [dia − tol, dia + tol].
export function paymentWindow(date, toleranceDays = PAYMENT_MATCH_TOLERANCE_DAYS) {
  const center = date instanceof Date ? date : dayStart(date);
  return { gte: new Date(center.getTime() - toleranceDays * DAY_MS), lte: new Date(center.getTime() + toleranceDays * DAY_MS) };
}

// Pura: filtra candidatos por valor exato (e, se informada, a conta). `transfers` já vêm da janela de datas.
export const matchPaymentCandidates = (transfers, { accountId, amount }) =>
  transfers.filter((t) => isFlowPayment(t) && (!accountId || t.fromAccountId === accountId) && money(t.amount).minus(money(amount)).abs().lt("0.005"));

// Heurística: a linha de transferência parece o pagamento de uma fatura de cartão?
export const looksLikeCardBillPaymentRow = (row) => !!(row?.toCardName || String(row?.kind ?? "") === "card_bill_payment" || /fatura/i.test(String(row?.description ?? "")));
