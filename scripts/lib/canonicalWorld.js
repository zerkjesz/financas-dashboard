// Fase 9.1.1 — ISOLAMENTO dos testes de "verdade do produto" (53a/53b/home-truth/telegram-read).
//
// Esses testes comparam o motor com alvos financeiros CONGELADOS (scripts/fase53a-targets.local.json — o
// retrato canônico da Fase 5.2D). Antes eles liam o estado AMBIENTE do DEV; qualquer estrutura legítima
// criada depois do retrato (compromisso CNPJ da 8.0.1, contas da casa da 9.1) mudava freeMoney e quebrava
// os testes sem que o código tivesse regredido.
//
// Aqui o teste roda dentro de uma TRANSAÇÃO INTERATIVA QUE SEMPRE DÁ ROLLBACK: dentro dela as estruturas
// posteriores ao retrato são postas de lado (nunca apagadas — só um UPDATE que nunca é commitado) e o
// motor/read-model é chamado com `client: tx`. Nada persiste: o DEV legítimo (CNPJ FUNDED, regras da casa)
// permanece exatamente como estava, e o helper PROVA isso comparando uma assinatura antes × depois.
//
//   posto de lado (só dentro da transação):
//     - RecurringRule kind="expense" (contas da casa — nasceram na Fase 9.1)
//     - ConfirmedCommitment com settlementMode="EXTERNAL_TRANSFER" (devolução ao CNPJ — Fase 8.0.1/9.1)
import { prisma } from "../../lib/prisma.js";

class RollbackSignal extends Error {}

export async function ambientSignature(client = prisma) {
  const [rules, transferCommitments] = await Promise.all([
    client.recurringRule.findMany({ where: { kind: "expense" }, select: { id: true, isActive: true }, orderBy: { id: "asc" } }),
    client.confirmedCommitment.findMany({ where: { settlementMode: "EXTERNAL_TRANSFER" }, select: { id: true, status: true }, orderBy: { id: "asc" } }),
  ]);
  return JSON.stringify({ rules, transferCommitments });
}

export async function withCanonicalWorld(fn) {
  const before = await ambientSignature();
  let result;
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.recurringRule.updateMany({ where: { kind: "expense" }, data: { isActive: false } });
        await tx.confirmedCommitment.updateMany({ where: { settlementMode: "EXTERNAL_TRANSFER" }, data: { status: "CANCELLED" } });
        result = await fn(tx);
        throw new RollbackSignal(); // SEMPRE reverte — nada do que aconteceu aqui dentro persiste
      },
      { timeout: 120000, maxWait: 30000 }
    );
  } catch (e) {
    if (!(e instanceof RollbackSignal)) throw e;
  }
  const after = await ambientSignature();
  if (before !== after) throw new Error("ISOLAMENTO VIOLADO: o estado ambiente mudou após o rollback (assinatura antes ≠ depois)");
  return result;
}
