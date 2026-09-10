// Fase 5.6.1 — resolve hook do Node que remapeia o guard de teste para o
// guard de reconciliação de PRODUÇÃO, APENAS quando a flag deliberada da
// fase está presente. Sem a flag, é um no-op (nenhum script muda de
// comportamento).
//
// Isso evita duplicar (e re-commitar) os ~2000 linhas dos scripts de apply
// só pra trocar uma linha de import. Os scripts ORIGINAIS rodam sem
// alteração; só a resolução do módulo `./lib/assertTestEnvironment.js`
// aponta pro `./lib/assertProductionReconciliation.js` (que exporta o mesmo
// nome `assertTestEnvironment` por alias).
//
// Uso: node --import ./scripts/prod-bootstrap-loader-register.mjs <script> [--dry-run]

const ENABLED = process.env.NORTE_PRODUCTION_RECONCILIATION === "561-approved";

export async function resolve(specifier, context, nextResolve) {
  if (ENABLED && /(^|\/)lib\/assertTestEnvironment\.js$/.test(specifier)) {
    const swapped = specifier.replace(/assertTestEnvironment\.js$/, "assertProductionReconciliation.js");
    return nextResolve(swapped, context);
  }
  return nextResolve(specifier, context);
}
