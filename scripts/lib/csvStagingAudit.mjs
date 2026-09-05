// Fase 5.0.2 — auditoria genérica e read-only de um CSV legado no formato do
// Norte antigo (Data;Tipo;Valor;Categoria;Forma de pagamento;Fixo;Parcela;
// Descrição — separador ";", decimal brasileiro "vírgula", BOM UTF-8, campos
// entre aspas podendo conter quebra de linha). NUNCA hardcode aqui nenhum
// valor/nome/descrição real de usuário nenhum — este módulo só sabe ler o
// FORMATO do arquivo, nunca o CONTEÚDO específico de ninguém. O caminho do
// arquivo real vem de fora (input local gitignored), nunca deste módulo.
import fs from "node:fs";
import crypto from "node:crypto";
import { money, addMoney } from "../../lib/money.js";
import { addMonthKey } from "../../lib/formatMoney.js";

export function computeFileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return { sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}

// Parser RFC4180-ish pra ";" — precisa respeitar aspas (campo pode conter ";"
// e quebra de linha dentro de aspas, como as descrições multi-linha deste
// formato). BOM é removido antes de tudo.
export function parseSemicolonCsv(rawText) {
  const text = rawText.replace(/^﻿/, "");
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ";") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// "512,00" -> Decimal(512.00). Nunca passa por Number no meio (decimal.js
// aceita string com ponto — normaliza vírgula->ponto antes, sem imprecisão).
function parseBrDecimal(s) {
  if (s == null || s === "") return null;
  return money(s.trim().replace(/\./g, "").replace(",", "."));
}

// "11/08/2026" -> Date UTC meia-noite. Formato fixo DD/MM/YYYY deste export.
function parseBrDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s || "").trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
}

function toCycleMonth(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function normalizeForMatching(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================================
// Leitura + classificação linha a linha — 100% read-only (só lê o arquivo do
// disco, nunca escreve). NÃO assume que a Data da row é a data real do
// movimento (item 5 do pedido) — reporta a raw date e deixa explícito que
// pode ser backfill.
// ============================================================================
export function auditCsvRows(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const table = parseSemicolonCsv(raw);
  if (table.length === 0) return { header: [], rows: [] };
  const header = table[0].map((h) => h.trim());
  const dataRows = table.slice(1).filter((r) => r.some((c) => c.trim() !== ""));

  const rows = dataRows.map((cols, idx) => {
    const [dataStr, tipo, valorStr, categoria, formaPagamento, fixo, parcela, descricao] = cols;
    const rawDate = dataStr?.trim() ?? null;
    const date = parseBrDate(rawDate);
    const amount = parseBrDecimal(valorStr);
    const parcelaMatch = /^(\d+)\/(\d+)$/.exec((parcela || "").trim());

    const categoriaNorm = normalizeForMatching(categoria);
    const formaNorm = normalizeForMatching(formaPagamento);
    const descNorm = normalizeForMatching(descricao);

    const anomalyFlags = [];
    let likelySemanticEntity = "UNKNOWN";

    const isFaturaCategory = categoriaNorm.includes("fatura cartao de credito") || categoriaNorm === "fatura";
    const isParcelasCategory = categoriaNorm.includes("parcelas cartao de credito");
    const isVaPayment = formaNorm.includes("vale alimentacao");
    const isCardPayment = formaNorm.includes("cartao de credito");
    const isPixPayment = formaNorm === "pix";
    const mentionsInstallment = /parcel(ei|ado|a|amos)/.test(descNorm) || /\d+\s*x\b/.test(descNorm) || /\d+\s*vezes/.test(descNorm);
    const mentionsTotalValue = /valor total/.test(descNorm);

    if (isFaturaCategory) {
      likelySemanticEntity = "CARD_BILL_PAYMENT";
      anomalyFlags.push("LEGACY_MODELING_ANOMALY: pagamento de fatura registrado como Gasto (Tipo=Gasto), não como quitação de fatura — payment reduces cash + card liability, nunca é consumo pessoal.");
    } else if (isParcelasCategory && parcelaMatch) {
      likelySemanticEntity = "EXTERNAL_INSTALLMENT";
      if (isCardPayment) anomalyFlags.push("Categoria diz 'Cartão de Crédito' mas semanticamente é parcela paga a credor externo (forma de pagamento real determina isso, não o rótulo da categoria).");
    } else if (isVaPayment) {
      likelySemanticEntity = tipo?.trim() === "Receita" ? "VA_INCOME" : "VA_EXPENSE";
    } else if (tipo?.trim() === "Receita") {
      likelySemanticEntity = "INCOME";
    } else if (isCardPayment && mentionsInstallment) {
      likelySemanticEntity = "CARD_PURCHASE_POSSIBLY_INSTALLMENT";
      if (mentionsTotalValue || !parcelaMatch) {
        anomalyFlags.push("Possível compra parcelada registrada pelo VALOR TOTAL (sem coluna Parcela preenchida, descrição menciona parcelamento) — valor pode não representar o gasto do ciclo, e sim o total da compra.");
      }
    } else if (isCardPayment) {
      likelySemanticEntity = "CARD_PURCHASE";
    } else if (isPixPayment) {
      likelySemanticEntity = "EXPENSE";
    } else {
      likelySemanticEntity = "EXPENSE";
    }

    if (!date) anomalyFlags.push("Data não parseável no formato DD/MM/YYYY esperado.");
    anomalyFlags.push("BACKFILL_POSSIBLE: a coluna Data pode refletir o dia do LANÇAMENTO retroativo, não necessariamente o dia real do evento — usar como evidência auxiliar, nunca sobrescrever automaticamente.");

    return {
      rowIndex: idx,
      rawDate,
      date: date?.toISOString() ?? null,
      cycleMonthOfRawDate: date ? toCycleMonth(date) : null,
      type: tipo?.trim() ?? null,
      amount: amount?.toString() ?? null,
      category: categoria?.trim() ?? null,
      paymentMethod: formaPagamento?.trim() ?? null,
      fixedFlag: fixo?.trim() || null,
      installmentMarker: parcela?.trim() || null,
      installmentNumber: parcelaMatch ? Number(parcelaMatch[1]) : null,
      installmentTotal: parcelaMatch ? Number(parcelaMatch[2]) : null,
      description: descricao ?? null,
      likelySemanticEntity,
      confidence: "CONFIRMED_BY_MEMORY", // existência do lançamento histórico — não o valor/classificação final.
      anomalyFlags,
    };
  });

  return { header, rows };
}

// ============================================================================
// Reconstrói candidatos de ExternalInstallmentPlan a partir das rows
// EXTERNAL_INSTALLMENT — agrupa por descrição normalizada (única chave
// disponível no CSV; sem id cruzável entre exports). Cadência mensal é a
// interpretação natural, mas cada mês projetado é explicitamente CANDIDATO,
// nunca confirmado (item 8/10 do pedido).
// ============================================================================
export function reconstructExternalInstallmentCandidates(rows, { asOf, nextIncomeDate }) {
  const externalRows = rows.filter((r) => r.likelySemanticEntity === "EXTERNAL_INSTALLMENT" && r.installmentNumber != null);
  const byDescription = new Map();
  for (const r of externalRows) {
    const key = normalizeForMatching(r.description);
    if (!byDescription.has(key)) byDescription.set(key, []);
    byDescription.get(key).push(r);
  }

  const plans = [];
  for (const [, observations] of byDescription) {
    // Se a mesma descrição aparecer mais de uma vez (exports diferentes),
    // usa a observação de posição MAIS ALTA (a mais recente no plano).
    observations.sort((a, b) => (b.installmentNumber ?? 0) - (a.installmentNumber ?? 0));
    const latest = observations[0];
    const N = latest.installmentNumber;
    const M = latest.installmentTotal;
    const observedDate = latest.date ? new Date(latest.date) : null;
    const observedCycle = latest.cycleMonthOfRawDate;

    const candidatePreviousInstallments = [];
    for (let n = 1; n < N; n++) {
      candidatePreviousInstallments.push({ number: n, status: "IMPLIED_BY_SEQUENCE_POSITION", note: "Não observada diretamente — inferida apenas pela existência de uma posição sequencial maior no CSV." });
    }

    const candidateFutureInstallments = [];
    let monthsElapsedToAsOf = null;
    if (observedCycle && asOf) {
      const [oy, om] = observedCycle.split("-").map(Number);
      const asOfCycle = `${asOf.getUTCFullYear()}-${String(asOf.getUTCMonth() + 1).padStart(2, "0")}`;
      const [ay, am] = asOfCycle.split("-").map(Number);
      monthsElapsedToAsOf = (ay - oy) * 12 + (am - om);
    }
    for (let n = N + 1; n <= M; n++) {
      const offset = n - N;
      const candidateMonth = observedCycle ? addMonthKey(observedCycle, offset) : null;
      candidateFutureInstallments.push({
        number: n,
        candidateMonth,
        status: "NEEDS_PAYMENT_EVIDENCE",
        scheduleBasis: "EXPECTED_FROM_SCHEDULE (cadência mensal assumida a partir da posição observada — não confirmado)",
      });
    }

    // projectedPosition > M (estritamente maior): a última parcela (M) já
    // teria vencido HÁ PELO MENOS UM MÊS antes de asOf — só aí o plano está
    // definitivamente para trás de nós. projectedPosition === M significa que
    // a ÚLTIMA parcela cai perto de agora — ainda é uma obrigação corrente
    // candidata, não "já resolvida" (limite anterior, `>=`, marcava esse mês
    // como completo cedo demais).
    const projectedPositionAtAsOf = monthsElapsedToAsOf != null ? N + monthsElapsedToAsOf : null;
    const likelyCompletedByAsOf = projectedPositionAtAsOf != null ? projectedPositionAtAsOf > M : null;
    const stillActiveCandidate = likelyCompletedByAsOf === false;

    // Marca se a projeção deste plano cairia dentro do horizonte atual
    // (<= próxima renda) — sem afirmar dueDate exata, só que a MENSALIDADE
    // do mês corrente/próximo é materialmente possível de existir.
    let mayFallWithinCurrentHorizon = null;
    if (stillActiveCandidate && nextIncomeDate) {
      mayFallWithinCurrentHorizon = true; // parcela mensal ativa é presumivelmente devida dentro de qualquer janela mensal, incluindo a atual.
    } else if (likelyCompletedByAsOf === true) {
      mayFallWithinCurrentHorizon = false;
    }

    plans.push({
      description: latest.description,
      amountObservedPerInstallment: latest.amount,
      observedInstallmentNumber: N,
      totalInstallmentCount: M,
      observedDate: latest.date,
      observedRawDate: latest.rawDate,
      candidatePreviousInstallments,
      candidateFutureInstallments,
      monthsElapsedSinceObservedToAsOf: monthsElapsedToAsOf,
      projectedPositionAtAsOf,
      likelyCompletedByAsOf,
      stillActiveCandidate,
      mayFallWithinCurrentHorizon,
      paymentStatusAsOf: "UNKNOWN_PAYMENT_STATUS",
      confidence: "CONFIRMED_BY_MEMORY (existência/posição na data do CSV) — UNKNOWN (continuidade após essa data)",
      source: "csv_staging_evidence",
    });
  }

  return plans;
}
