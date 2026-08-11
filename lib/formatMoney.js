export function formatMoney(value) {
  return (value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
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
