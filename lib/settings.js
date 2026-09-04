import { prisma } from "./prisma.js";

// Fase 3.2 — service central do singleton AppSettings. `id` fixo em "default" é a
// ÚNICA linha válida (ver comentário no schema.prisma) — nunca busque/crie
// AppSettings por outro id.
export const APP_SETTINGS_ID = "default";

// Fallback de domínio — usado SOMENTE se o singleton ainda não foi semeado (banco
// recém-provisionado, ambiente isolado sem seed rodado). Estes são os ÚNICOS dois
// lugares do código onde os valores oficiais (24, 10, 2026-08-24, 2026-08-21)
// existem — aqui (rede de segurança) e em scripts/seed-app-settings.mjs (fonte de
// verdade real, gravada no banco). Nenhum outro arquivo deve hardcodar esses
// números — sempre chame getAppSettings().
const DOMAIN_FALLBACK = Object.freeze({
  cycleStartDay: 24,
  safetyMarginPercent: 10,
  operationalHistoryStart: new Date("2026-08-24T00:00:00.000Z"),
  vaHistoryStart: new Date("2026-08-21T00:00:00.000Z"),
});

// ESTRITAMENTE read-only — nunca cria o singleton (auditoria/rota de API que só lê
// configuração não pode ter efeito colateral de escrita). Se o singleton ainda não
// foi semeado, cai no fallback de domínio acima E avisa no log — isso não deve
// acontecer em uso normal depois que scripts/seed-app-settings.mjs rodar uma vez no
// branch dev; é rede de segurança, não o caminho esperado.
export async function getAppSettings() {
  const settings = await prisma.appSettings.findUnique({ where: { id: APP_SETTINGS_ID } });
  if (settings) return settings;

  console.warn(
    `[lib/settings.js] AppSettings singleton ("${APP_SETTINGS_ID}") não encontrado — usando fallback de domínio hardcoded. ` +
      "Rode scripts/seed-app-settings.mjs no branch dev pra semear o valor real."
  );
  return { id: APP_SETTINGS_ID, ...DOMAIN_FALLBACK, createdAt: null, updatedAt: null };
}
