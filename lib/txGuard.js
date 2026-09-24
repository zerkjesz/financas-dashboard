// Fase 7D.1 — isola uma escrita do wizard/menu num SAVEPOINT dentro da
// transação do update. Um erro (validação de domínio OU erro SQL, ex.:
// CHECK constraint) reverte SÓ o que essa escrita fez e vira uma resposta
// amigável — em vez de abortar a transação inteira (que deixaria o
// Telegram reentregando o mesmo update pra sempre sem o usuário ver nada).
// Nenhum efeito parcial sobrevive: tudo que a função escreveu antes do erro
// é desfeito (importante pro lote: "se um item falhar, ZERO persistência").
//
// Sem transação (client === prisma: modo dev bypass/scripts) não há
// savepoint possível — o erro propaga como sempre.
import { prisma } from "./prisma.js";

let counter = 0;

export async function runGuarded(client, fn) {
  if (client === prisma || typeof client?.$executeRawUnsafe !== "function") {
    return { ok: true, value: await fn() };
  }
  const name = `guard_${++counter}`;
  await client.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    const value = await fn();
    await client.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return { ok: true, value };
  } catch (error) {
    await client.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    console.error(`[txGuard] escrita revertida: ${error?.message?.split("\n").filter(Boolean).slice(-1)[0] ?? error}`);
    return { ok: false, error };
  }
}

// Mensagem segura pro usuário: erros de domínio (Error escrito em pt-BR no
// próprio serviço) passam; erros técnicos do Prisma/Postgres viram genérica.
export function friendlyErrorMessage(error) {
  const msg = String(error?.message ?? "");
  const technical = /Invalid `prisma|PrismaClient|ConnectorError|violates|constraint|Unique constraint|Foreign key|transaction/i.test(msg) || String(error?.name ?? "").startsWith("PrismaClient");
  if (technical) return "o banco recusou essa gravação (dados incompatíveis com uma regra de validação)";
  return msg.split("\n")[0] || "erro inesperado";
}
