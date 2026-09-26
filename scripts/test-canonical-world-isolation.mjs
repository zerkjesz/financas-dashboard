// Fase 9.1.1 — PROVA de que as suítes de "verdade do produto" não dependem do estado ambiente do DEV.
// Cria fixtures MARK (um compromisso de devolução tipo CNPJ FUNDED e uma conta da casa), e mostra:
//   (a) o freeMoney AMBIENTE muda com elas; (b) o freeMoney do MUNDO CANÔNICO (transação revertida) NÃO muda;
//   (c) depois do helper, nada do ambiente foi alterado (rollback real) e a assinatura é idêntica.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money, serializeMoney } from "../lib/money.js";
import { buildFinancialEngineSummary } from "../lib/financialEngine.js";
import { withCanonicalWorld, ambientSignature } from "./lib/canonicalWorld.js";

const MARK = "TESTE_F911_ISO";
const NOW = new Date("2026-09-20T15:00:00.000Z");
let pass = 0, fail = 0;
const check = (name, cond, d) => { if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}${d ? " — " + d : ""}`); } };
const n = (x) => Number(serializeMoney(money(x)));
const ids = { commitment: null, rule: null };

const ambient = async () => n((await buildFinancialEngineSummary({ now: NOW })).freeMoney);
const canonical = async () => withCanonicalWorld(async (tx) => n((await buildFinancialEngineSummary({ now: NOW, client: tx })).freeMoney));

async function main() {
  const ambient0 = await ambient();
  const canon0 = await canonical();
  const sig0 = await ambientSignature();

  const c = await prisma.confirmedCommitment.create({ data: { description: `${MARK} Devolver ao CNPJ`, amount: 777, dueDate: null, status: "FUNDED", fundedAt: NOW, settlementMode: "EXTERNAL_TRANSFER", shortLabel: "CNPJ" } });
  ids.commitment = c.id;
  const r = await prisma.recurringRule.create({ data: { kind: "expense", isActive: true, name: `${MARK} Aluguel`, amount: 555, dayOfMonth: 20, // vence antes da próxima renda (24/09) do relógio deste teste
       category: "Moradia", amountKind: "FIXED" } });
  ids.rule = r.id;

  const ambient1 = await ambient();
  const canon1 = await canonical();
  const sig1 = await ambientSignature();

  check("[ISO] o estado ambiente MUDA com CNPJ + conta da casa (−777 −555)", Math.abs(ambient1 - ambient0 - -(777 + 555)) < 0.005, `${ambient0} → ${ambient1}`);
  check("[ISO] o freeMoney do mundo canônico NÃO muda (independe do estado ambiente)", Math.abs(canon1 - canon0) < 0.005, `${canon0} → ${canon1}`);
  check("[ISO] o mundo canônico difere do ambiente enquanto existirem as fixtures (a neutralização está ativa)", Math.abs(canon1 - ambient1) > 1);
  check("[ISO] rollback real: as fixtures continuam ATIVAS/FUNDED depois do helper (nada persistiu)", (await prisma.recurringRule.findUnique({ where: { id: r.id } })).isActive === true && (await prisma.confirmedCommitment.findUnique({ where: { id: c.id } })).status === "FUNDED");
  check("[ISO] assinatura do ambiente mudou só pelas fixtures (e é a mesma antes/depois de cada rodada do helper)", sig0 !== sig1 && sig1 === (await ambientSignature()));
  let threw = false;
  try { await withCanonicalWorld(async () => { throw new Error("falha proposital dentro do mundo"); }); } catch (e) { threw = /falha proposital/.test(e.message); }
  check("[ISO] erro dentro do mundo propaga e também reverte (ambiente intacto)", threw && sig1 === (await ambientSignature()));
}

main()
  .catch((e) => { fail++; console.log(`❌ exceção: ${e.stack || e}`); })
  .finally(async () => {
    if (ids.rule) await prisma.recurringRule.deleteMany({ where: { id: ids.rule } }).catch(() => {});
    if (ids.commitment) await prisma.confirmedCommitment.deleteMany({ where: { id: ids.commitment } }).catch(() => {});
    const left = (await prisma.recurringRule.count({ where: { name: { contains: MARK } } })) + (await prisma.confirmedCommitment.count({ where: { description: { contains: MARK } } }));
    check("cleanup: zero dado de teste restante", left === 0, String(left));
    console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
