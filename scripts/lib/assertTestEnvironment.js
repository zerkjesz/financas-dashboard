// Guarda de segurança pra qualquer script que ESCREVE dados de teste no banco.
// Importe e chame assertTestEnvironment() como a PRIMEIRA linha do script — antes de
// qualquer import do Prisma, se possível — pra abortar o mais cedo possível se o
// ambiente não for INEQUIVOCAMENTE um ambiente de teste.
//
// Princípio: fail closed. Não é "bloqueia se parecer produção" — é "só libera se
// TODAS as 3 condições provarem que é seguro". Falta de configuração (DATABASE_ENV
// não setada, por exemplo) é tratada como risco, não como "deve ser dev por padrão".
//
// Não existe "override"/flag pra pular essa checagem de propósito: se o script
// precisa mesmo rodar contra produção (ex: uma migração de dado one-shot, deliberada,
// como scripts/migrate-legacy-transactions.js), ele não deve importar este módulo —
// este módulo é só pra scripts que NUNCA, em circunstância nenhuma, deveriam escrever
// em produção (testes de integração, scripts de teste, etc).
//
// As 3 condições, TODAS obrigatórias:
//   1. VERCEL_ENV !== "production" — a Vercel seta essa variável automaticamente em
//      todo build/runtime de produção, sem precisar configurar nada.
//   2. DATABASE_ENV é EXATAMENTE "development" ou "test" — variável nova, setada à
//      mão no seu .env local (ver docs/dev-environment.md). Qualquer outro valor,
//      incluindo ausente/vazio, bloqueia. Isso é o que torna isto fail-closed: sem
//      essa variável setada explicitamente, o script não roda, ponto.
//   3. DATABASE_URL não aponta pro host de produção conhecido deste projeto (Neon,
//      branch main) — camada extra, independente da variável acima, pro caso de
//      DATABASE_ENV estar mal configurada (ex: alguém copiou .env errado).
//
// Ajuste PRODUCTION_DB_HOST_SUBSTRING se o branch de produção mudar de endpoint.
const PRODUCTION_DB_HOST_SUBSTRING = "ep-odd-lab-ac5srwxf-pooler";
const ALLOWED_DATABASE_ENV = new Set(["development", "test"]);

export function assertTestEnvironment() {
  const problems = [];

  if (process.env.VERCEL_ENV === "production") {
    problems.push(`VERCEL_ENV="production"`);
  }

  const databaseEnv = process.env.DATABASE_ENV;
  if (!ALLOWED_DATABASE_ENV.has(databaseEnv)) {
    problems.push(
      `DATABASE_ENV precisa ser exatamente "development" ou "test" — valor atual: ${JSON.stringify(databaseEnv ?? null)}`
    );
  }

  const dbUrl = process.env.DATABASE_URL || "";
  if (!dbUrl) {
    problems.push("DATABASE_URL não está setada");
  } else if (dbUrl.includes(PRODUCTION_DB_HOST_SUBSTRING)) {
    problems.push(`DATABASE_URL aponta pro host de produção (contém "${PRODUCTION_DB_HOST_SUBSTRING}")`);
  }

  if (problems.length > 0) {
    console.error("\n🛑 ABORTADO — este script escreve dados de teste e o ambiente não está claramente seguro:");
    for (const p of problems) console.error(`   - ${p}`);
    console.error(
      "\nEsse script nunca deve rodar contra o banco de produção. Aponte DATABASE_URL pro branch de " +
        "dev/test do Neon e sete DATABASE_ENV=development (ver docs/dev-environment.md) antes de rodar de novo.\n"
    );
    process.exit(1);
  }
}
