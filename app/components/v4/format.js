// Fase 9.1 — formatação do v4 (pt-BR). Puro, sem DOM.
export function fmt(n) {
  return "R$ " + Math.abs(Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// sem centavos quando o valor é inteiro (R$ 130, R$ 1.000) — usado em rótulos compactos (marcos, +R$X/mês)
export function fmtS(n) {
  const r = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isInteger(r) ? "R$ " + Math.abs(r).toLocaleString("pt-BR") : fmt(r);
}
export function signed(n) {
  return (n < 0 ? "−" : "+") + fmt(n);
}
// "1.234,56" | "1234,56" | "1234.56" -> 1234.56 (0 se inválido)
export function parseBR(s) {
  const t = String(s ?? "").trim().replace(/\s/g, "");
  if (!t) return 0;
  const norm = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : /^\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, "") : t;
  const v = Number(norm);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
export function joinNames(arr) {
  return arr.length <= 1 ? arr[0] || "" : arr.slice(0, -1).join(", ") + " e " + arr[arr.length - 1];
}
export function plural(n, one, many) {
  return n === 1 ? one : many;
}
