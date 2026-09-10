// Fase 5.6.1 — guard EXPLÍCITO de bootstrap de reconciliação em PRODUÇÃO.
//
// Substitui `assertTestEnvironment()` APENAS nas cópias `*-PROD.mjs` dos
// scripts de apply de reconciliação, e SÓ para a Fase 5.6.1 (bootstrap
// único, autorizado pelo dono, de dados que a Fase 5.6 provou faltarem em
// produção). Nenhum script de teste importa este arquivo.
//
// É deliberadamente mais estrito que só "não é produção": exige QUATRO
// condições explícitas simultâneas, todas passadas à mão pelo orquestrador
// (`scripts/bootstrap-production-reconciliation.mjs`). Nenhuma delas tem
// default. Uma execução acidental (sem as 4 flags) aborta.
//
// Nada de valor real, secret, hostname ou id aparece aqui — a identidade
// esperada vem por env var (NORTE_PROD_ENDPOINT), setada pelo orquestrador a
// partir do `neonctl`.

export function assertProductionReconciliation() {
  const problems = [];

  // 1) ambiente declarado como produção
  if (process.env.DATABASE_ENV !== "production") {
    problems.push(`DATABASE_ENV precisa ser exatamente "production" — atual: ${JSON.stringify(process.env.DATABASE_ENV ?? null)}`);
  }

  // 2) flag deliberada da fase
  if (process.env.NORTE_PRODUCTION_RECONCILIATION !== "561-approved") {
    problems.push(`NORTE_PRODUCTION_RECONCILIATION precisa ser exatamente "561-approved"`);
  }

  // 3) o DATABASE_URL aponta pro endpoint de produção esperado (a identidade
    //   esperada vem do orquestrador via neonctl — nunca hardcoded aqui)
  const url = process.env.DATABASE_URL || "";
  const expectedEndpoint = process.env.NORTE_PROD_ENDPOINT || "";
  if (!expectedEndpoint) {
    problems.push(`NORTE_PROD_ENDPOINT não definido — o orquestrador precisa passar a identidade esperada do endpoint`);
  } else if (!url.includes(expectedEndpoint)) {
    problems.push(`DATABASE_URL não contém o endpoint de produção esperado`);
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    problems.push(`DATABASE_URL ausente ou malformada`);
  }

  // 4) nunca dentro de um runtime Vercel (function/build)
  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    problems.push(`rodando dentro de um runtime Vercel — o bootstrap é uma ferramenta LOCAL, nunca deployada`);
  }

  if (problems.length > 0) {
    console.error("\n🛑 ABORTADO (assertProductionReconciliation) — condições de segurança do bootstrap 5.6.1 não satisfeitas:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nEste guard só libera com as 4 flags do orquestrador. Nenhuma tem default.\n");
    process.exit(1);
  }

  console.log("✅ assertProductionReconciliation OK — bootstrap 5.6.1 autorizado (DATABASE_ENV=production + flag + endpoint + não-Vercel).");
}

// Alias: o loader `scripts/prod-bootstrap-loader.mjs` remapeia
// `./lib/assertTestEnvironment.js` -> este arquivo quando
// NORTE_PRODUCTION_RECONCILIATION=561-approved. Os scripts originais fazem
// `import { assertTestEnvironment }` — então o nome precisa existir aqui.
export { assertProductionReconciliation as assertTestEnvironment };

