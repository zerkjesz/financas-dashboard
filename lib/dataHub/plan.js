import ADAPTERS from "./adapters.js";

// ============================================================================
// Fase 6.0 (Design Freeze) — MOTOR DE PLANEJAMENTO. Usado IDENTICAMENTE pelo
// dry-run (preview) e pelo apply (item 43 do pedido: "não criar função fake
// pra preview e outra regra diferente pra apply"). Nunca escreve nada —
// devolve um plano descritivo; quem chama decide se persiste.
//
// MODOS (item 44):
//   adicionar — nunca toca um registro existente; duplicata (por ID ou
//               chave natural) vira SKIP, nunca erro.
//   atualizar — só toca registro com correspondência COMPROVADA (ID ou
//               chave natural única); sem correspondência = SKIP (nunca
//               cria por acidente em modo atualizar).
//   substituir — tratado à parte em replace.js (escopo fixo: ledger dentro
//               de um período), nunca passa por este arquivo.
//
// CONFLITO — definição explícita (item 48/52 do pedido: "match ambíguo:
// nunca escolher silenciosamente"):
//   - match por ID exato (a linha veio de uma exportação do próprio Norte,
//     round-trip) -> UPDATE direto, alta confiança, nunca vira conflito.
//   - match por CHAVE NATURAL (nome/data/categoria — prova razoável, não
//     uma prova forte) -> vira CONFLITO: precisa de "Manter o atual" /
//     "Usar o do arquivo" / "Ver depois" antes do apply.
//   - match AMBÍGUO (2+ registros bateram a mesma chave natural) -> nunca
//     um conflito de 3 opções (não existe "o" registro pra escolher usar) —
//     fica em INVALID com instrução de como resolver (adicionar a coluna ID).
// ============================================================================

function diffData(existing, data, diffFields) {
  const changed = {};
  for (const f of diffFields) {
    if (!(f in data)) continue;
    const newVal = data[f];
    const oldVal = existing[f];
    const oldComparable = oldVal && typeof oldVal.toNumber === "function" ? oldVal.toNumber() : oldVal instanceof Date ? oldVal.toISOString() : oldVal;
    const newComparable = newVal instanceof Date ? newVal.toISOString() : newVal;
    if (String(oldComparable ?? "") !== String(newComparable ?? "")) changed[f] = newVal;
  }
  return changed;
}

export async function planImport({ prisma, mode, datasets, rowsBySheet }) {
  const perDataset = {};
  const fingerprint = [];
  const sampleDiffRows = [];
  const summary = { creates: 0, updates: 0, skips: 0, invalid: 0, conflicts: 0 };

  for (const key of datasets) {
    const adapter = ADAPTERS[key];
    const rows = rowsBySheet[key] || [];
    if (!adapter) {
      perDataset[key] = { totalRows: rows.length, creates: [], updates: [], skips: [], invalid: rows.map(() => "dataset não é importável"), conflicts: [] };
      summary.invalid += rows.length;
      continue;
    }
    if (!adapter.modes.includes(mode)) {
      perDataset[key] = { totalRows: rows.length, creates: [], updates: [], skips: rows.map(() => "modo não suportado para este dataset"), invalid: [], conflicts: [] };
      summary.skips += rows.length;
      continue;
    }

    const ctx = await adapter.prepare(prisma);
    const bucket = { totalRows: rows.length, creates: [], updates: [], skips: [], invalid: [], conflicts: [] };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowLabel = row.description || row.name || row.category || `linha ${i + 2}`;
      const match = await adapter.findMatch(prisma, row, ctx);

      if (mode === "add") {
        if (match.kind === "natural_key" || match.kind === "id" || match.kind === "ambiguous") {
          bucket.skips.push({ row: i, label: rowLabel, reason: "já existe" });
          sampleDiffRows.push({ tag: "Ignora", dataset: key, label: rowLabel, sub: "já existe", before: null, after: null });
          continue;
        }
        const result = await adapter.toData(prisma, row, ctx);
        if (result.invalid) {
          bucket.invalid.push({ row: i, label: rowLabel, reason: result.invalid });
          continue;
        }
        bucket.creates.push({ row: i, label: rowLabel, data: result.data });
        sampleDiffRows.push({ tag: "Novo", dataset: key, label: rowLabel, sub: key, before: null, after: result.data });
        continue;
      }

      // mode === "update"
      if (match.kind === "ambiguous") {
        bucket.invalid.push({ row: i, label: rowLabel, reason: "correspondência ambígua — adicione a coluna ID pra resolver", candidateIds: match.candidates.map((c) => c.id) });
        continue;
      }
      if (match.kind !== "id" && match.kind !== "natural_key") {
        bucket.skips.push({ row: i, label: rowLabel, reason: "sem correspondência" });
        continue;
      }
      const existing = match.candidates[0];
      const result = await adapter.toData(prisma, row, ctx);
      if (result.invalid) {
        bucket.invalid.push({ row: i, label: rowLabel, reason: result.invalid });
        continue;
      }
      const changed = diffData(existing, result.data, adapter.diffFields);
      if (Object.keys(changed).length === 0) {
        bucket.skips.push({ row: i, label: rowLabel, reason: "sem mudanças" });
        continue;
      }
      const before = Object.fromEntries(Object.keys(changed).map((f) => [f, existing[f]]));
      if (match.kind === "natural_key") {
        // Match por chave natural (não ID) — confiança razoável, não prova
        // forte. Vira CONFLITO: precisa de resolução explícita antes do
        // apply (item 52). `resolution` começa null (equivalente a "Ver
        // depois" — bloqueia o apply deste dataset até resolver).
        const conflictKey = `${key}:${i}`;
        bucket.conflicts.push({ row: i, label: rowLabel, id: existing.id, data: changed, before, conflictKey, resolution: null });
        sampleDiffRows.push({ tag: "Conflito", dataset: key, label: rowLabel, sub: Object.keys(changed).join(", "), before, after: changed, conflictKey });
        if (existing.updatedAt) fingerprint.push({ model: adapter.model, id: existing.id, updatedAt: existing.updatedAt.toISOString() });
        continue;
      }
      bucket.updates.push({ row: i, label: rowLabel, id: existing.id, data: changed });
      sampleDiffRows.push({ tag: "Atualiza", dataset: key, label: rowLabel, sub: Object.keys(changed).join(", "), before, after: changed });
      if (existing.updatedAt) fingerprint.push({ model: adapter.model, id: existing.id, updatedAt: existing.updatedAt.toISOString() });
    }

    perDataset[key] = bucket;
    summary.creates += bucket.creates.length;
    summary.updates += bucket.updates.length;
    summary.skips += bucket.skips.length;
    summary.invalid += bucket.invalid.length;
    summary.conflicts += bucket.conflicts.length;
  }

  return { perDataset, summary, sampleDiffRows: sampleDiffRows.slice(0, 200), fingerprint };
}

// Concorrência otimista (item 53) — compara o fingerprint gravado no
// preview contra o estado REAL agora; qualquer divergência aborta o apply.
export async function fingerprintStillValid(prisma, fingerprint) {
  for (const entry of fingerprint) {
    const current = await prisma[entry.model].findUnique({ where: { id: entry.id }, select: { updatedAt: true } });
    if (!current) return { valid: false, reason: `registro ${entry.id} não existe mais` };
    if (current.updatedAt.toISOString() !== entry.updatedAt) return { valid: false, reason: `registro ${entry.id} mudou desde a revisão` };
  }
  return { valid: true };
}

export { diffData };
