export function formatMoney(value) {
  return (value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// Datas de calendário (vencimento, fechamento, previsão) são guardadas como meia-noite UTC —
// formatar sem forçar UTC desloca um dia pra trás em fusos negativos (ex: Brasil). Timestamps
// reais (occurredAt/createdAt) não devem usar isso — aí o fuso local é o comportamento certo.
export function formatDate(date) {
  return new Date(date).toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

// Fase 8.0.1 — prazo de um compromisso: null/inválido => "Sem prazo definido" (nunca
// "Invalid Date", 01/01/1970, "null" ou "undefined").
export const NO_DUE_DATE_LABEL = "Sem prazo definido";
export function formatDueDate(date) {
  if (date == null || date === "") return NO_DUE_DATE_LABEL;
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? NO_DUE_DATE_LABEL : formatDate(d);
}

export function monthKey(date) {
  const d = typeof date === "string" ? date : date.toISOString();
  return d.slice(0, 7); // YYYY-MM
}

export function addMonthKey(key, months) {
  const [year, month] = key.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
