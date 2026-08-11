export function formatMoney(value) {
  return (value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// Datas de calendário (vencimento, fechamento, previsão) são guardadas como meia-noite UTC —
// formatar sem forçar UTC desloca um dia pra trás em fusos negativos (ex: Brasil). Timestamps
// reais (occurredAt/createdAt) não devem usar isso — aí o fuso local é o comportamento certo.
export function formatDate(date) {
  return new Date(date).toLocaleDateString("pt-BR", { timeZone: "UTC" });
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
