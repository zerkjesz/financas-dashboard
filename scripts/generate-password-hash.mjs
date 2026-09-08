// Fase 5.3C — implementa o script desenhado (não criado) em
// docs/schema-v2-blueprint.md, item 11. Read-only no sentido financeiro: não
// toca o banco, só imprime um valor pra colar em DASHBOARD_PASSWORD_HASH.
//
// Uso: node scripts/generate-password-hash.mjs "sua senha aqui"
//
// A senha em si nunca é salva em lugar nenhum — só o hash resultante é
// impresso. Vale limpar o histórico do shell depois de rodar (a senha em
// texto puro passa pelos argumentos do processo).
import { hashPassword } from "../lib/auth/password.js";

const password = process.argv[2];
if (!password) {
  console.error('uso: node scripts/generate-password-hash.mjs "senha"');
  process.exit(1);
}

console.log(hashPassword(password));
