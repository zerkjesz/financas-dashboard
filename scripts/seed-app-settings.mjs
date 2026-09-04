// Fase 3.2 — seed EXPLÍCITO do singleton AppSettings. Rodado manualmente, uma vez,
// no branch dev. NUNCA chamado implicitamente por um caminho de leitura (ver
// lib/settings.js:getAppSettings, que é estritamente read-only e nunca importa
// nada deste arquivo).
//
// create-only / idempotente: se o singleton já existir, não faz nada (não
// sobrescreve valores que porventura já tenham sido ajustados manualmente depois
// do seed inicial). Pra atualizar valores de propósito, edite direto (ou crie um
// script de update separado, deliberado) — este script é só o "primeiro registro".
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { APP_SETTINGS_ID } from "../lib/settings.js";

// Valores oficiais desta fase (únicos dois lugares no código que os hardcodam —
// ver lib/settings.js). cycleStartDay/safetyMarginPercent Int (não são dinheiro,
// ver schema.prisma). Datas em UTC meia-noite, mesmo padrão usado em todo o app
// (ex: lib/cardBillCalculator.js:dayInMonthKey).
const OFFICIAL_VALUES = {
  id: APP_SETTINGS_ID,
  cycleStartDay: 24,
  safetyMarginPercent: 10,
  operationalHistoryStart: new Date("2026-08-24T00:00:00.000Z"),
  vaHistoryStart: new Date("2026-08-21T00:00:00.000Z"),
};

async function main() {
  const existing = await prisma.appSettings.findUnique({ where: { id: APP_SETTINGS_ID } });
  if (existing) {
    console.log(`✅ AppSettings("${APP_SETTINGS_ID}") já existe — nada a fazer (script é create-only).`);
    console.log(existing);
    return;
  }

  const created = await prisma.appSettings.create({ data: OFFICIAL_VALUES });
  console.log(`✅ AppSettings("${APP_SETTINGS_ID}") criado:`);
  console.log(created);
}

main()
  .catch((err) => {
    console.error("💥 Erro ao semear AppSettings:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
