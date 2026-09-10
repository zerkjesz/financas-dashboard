// Fase 5.6.1 — guard EXPLÍCITO de bootstrap de reconciliação em PRODUÇÃO.
//
// Substitui `assertTestEnvironment()` (via o resolve hook
// `scripts/prod-bootstrap-loader.mjs`) APENAS nas execuções orquestradas
// pelo bootstrap 5.6.1. Nenhum script de teste importa este arquivo.
//
// PROVA de que este caminho é MAIS FORTE que o `assertTestEnvironment`
// original (não só "neutraliza"):
//
//   assertTestEnvironment (ORIGINAL): guarda NEGATIVA — nega se PARECER
//   produção (VERCEL_ENV!=production, DATABASE_ENV∈{dev,test}, DATABASE_URL
//   sem o host de produção). 3 condições, todas "não seja prod".
//
//   assertProductionReconciliation (ESTE): guarda POSITIVA — só libera se
//   TODAS as condições abaixo forem verdadeiras E, para escrita real
//   (`--apply`), se o orquestrador tiver acabado de passar os 8 gates de
//   rede (branch=production, 12 migrations, Deployment Protection=all,
//   backups existem, etc.) e gravado o arquivo de autorização desta
//   execução. Uma execução direta de `node scripts/apply-*.mjs` — com ou
//   sem `DATABASE_ENV=production` no shell — NÃO passa: sem o loader, cai no
//   guard ORIGINAL; com o loader mas sem `--apply`, é dry-run (zero write);
//   com `--apply` mas sem o orquestrador, falta o arquivo de autorização.
//
// Nada de valor real, secret, hostname ou id aparece aqui.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // scripts/lib
const AUTH_FILE = path.join(HERE, ".bootstrap-authorized.json"); // scripts/lib/.bootstrap-authorized.json
// Janela CURTA (60 s): o orquestrador grava o arquivo imediatamente antes de
// spawnar CADA fase de --apply e o deleta imediatamente depois — nunca fica
// válido entre fases nem entre execuções.
const AUTH_MAX_AGE_MS = 60 * 1000;

export function assertProductionReconciliation() {
  const problems = [];
  const isApply = process.argv.includes("--apply");

  // 1) ambiente declarado como produção (POSITIVO — não "não seja dev")
  if (process.env.DATABASE_ENV !== "production") {
    problems.push(`DATABASE_ENV precisa ser exatamente "production" — atual: ${JSON.stringify(process.env.DATABASE_ENV ?? null)}`);
  }

  // 2) flag deliberada da fase
  if (process.env.NORTE_PRODUCTION_RECONCILIATION !== "561-approved") {
    problems.push(`NORTE_PRODUCTION_RECONCILIATION precisa ser exatamente "561-approved"`);
  }

  // 3) DATABASE_URL aponta pro endpoint de produção esperado (identidade
    //   vem do orquestrador via neonctl — nunca hardcoded) E é a conexão
    //   DIRETA (unpooled) — DDL/reconciliação nunca deve passar pelo pooler.
  const url = process.env.DATABASE_URL || "";
  const expectedEndpoint = process.env.NORTE_PROD_ENDPOINT || "";
  if (!/^postgres(ql)?:\/\//.test(url)) {
    problems.push(`DATABASE_URL ausente ou malformada`);
  }
  if (!expectedEndpoint) {
    problems.push(`NORTE_PROD_ENDPOINT não definido — o orquestrador precisa passar a identidade esperada`);
  } else {
    let host = "";
    try { host = new URL(url).hostname; } catch { /* já reportado acima */ }
    if (!host.includes(expectedEndpoint)) problems.push(`DATABASE_URL não contém o endpoint de produção esperado`);
    if (/-pooler\./.test(host)) problems.push(`DATABASE_URL usa o pooler — a reconciliação exige conexão direta (unpooled)`);
  }

  // 4) nunca dentro de um runtime Vercel
  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    problems.push(`rodando dentro de um runtime Vercel — o bootstrap é ferramenta LOCAL, nunca deployada`);
  }

  // 5) para ESCRITA REAL: o orquestrador tem que ter passado os 8 gates de
    //   rede AGORA e gravado o arquivo de autorização desta execução.
  if (isApply) {
    let auth = null;
    try { auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")); } catch { /* ausente */ }
    if (!auth) {
      problems.push(`--apply exige autorização do orquestrador (arquivo ${path.basename(AUTH_FILE)} ausente). Rode via scripts/bootstrap-production-reconciliation.mjs --apply, nunca o script direto.`);
    } else {
      if (!process.env.NORTE_BOOTSTRAP_RUN_ID || auth.runId !== process.env.NORTE_BOOTSTRAP_RUN_ID) {
        problems.push(`--apply: runId da autorização não bate com esta execução`);
      }
      // per-fase: a autorização é emitida pra UMA fase específica (nonce +
      // phase). Um subprocesso de outra fase — ou uma 2ª execução da mesma —
      // não bate.
      if (!process.env.NORTE_BOOTSTRAP_PHASE || auth.phase !== process.env.NORTE_BOOTSTRAP_PHASE) {
        problems.push(`--apply: a autorização é pra a fase "${auth.phase}", não "${process.env.NORTE_BOOTSTRAP_PHASE ?? "(nenhuma)"}"`);
      }
      if (!process.env.NORTE_BOOTSTRAP_NONCE || auth.nonce !== process.env.NORTE_BOOTSTRAP_NONCE) {
        problems.push(`--apply: nonce da autorização não bate (single-use consumido)`);
      }
      if (!auth.ts || Date.now() - auth.ts > AUTH_MAX_AGE_MS) {
        problems.push(`--apply: autorização do orquestrador expirada (>60 s)`);
      }
      if (auth.allGatesGreen !== true) {
        problems.push(`--apply: o orquestrador não confirmou os 8 gates verdes`);
      }
    }
  }

  if (problems.length > 0) {
    console.error("\n🛑 ABORTADO (assertProductionReconciliation) — condições de segurança do bootstrap 5.6.1 não satisfeitas:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nEste guard é POSITIVO: só libera com todas as condições. Para --apply, só via o orquestrador.\n");
    process.exit(1);
  }

  console.log(`✅ assertProductionReconciliation OK — ${isApply ? "APPLY autorizado pelo orquestrador" : "dry-run (zero write)"}.`);
}

// Alias: o loader importa este arquivo no lugar de assertTestEnvironment.js;
// os scripts fazem `import { assertTestEnvironment }`.
export { assertProductionReconciliation as assertTestEnvironment };
