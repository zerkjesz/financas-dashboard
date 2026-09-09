import { NextResponse } from "next/server";
import { verifyPassword } from "@/lib/auth/password";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { deriveRateLimitKey, isBlocked, recordFailure, clearAttempts } from "@/lib/auth/rateLimitDb";
import { getDashboardPasswordHash, getSessionSecret, shouldUseSecureCookie } from "@/lib/auth/envConfig";

// Fase 5.3C — única rota fora da allowlist de middleware.js que aceita
// requisição sem sessão (é o próprio login). Item 16: toda resposta de erro
// é uma mensagem mínima e genérica — nunca vaza se foi "senha errada" vs
// "config ausente" de forma que ajude um atacante a distinguir, além do
// necessário pro usuário legítimo entender o que fazer.
//
// Fase 5.5 — rate limit trocado de contador só-em-cookie (client-resettable,
// achado real da Fase 5.4F.1: um cliente que não envia/limpa o cookie
// reiniciava a contagem a zero) pra enforcement AUTORITATIVO em Postgres
// (lib/auth/rateLimitDb.js) — mesmo banco de tudo, zero provider novo. Item
// 13 da fase (CRÍTICO): se o backend autoritativo estiver indisponível,
// FAIL_CLOSED — a tentativa é tratada como bloqueada, nunca cai
// silenciosamente pra "sem limite". Cookie-limiter antigo (lib/auth/
// rateLimit.js) REMOVIDO nesta fase — decisão A do item 12, não B: manter
// os dois seria complexidade real (duas máquinas de estado independentes)
// pra um benefício de defense-in-depth marginal, já que o DB é agora
// autoritativo e fail-closed.
export async function POST(request) {
  const sessionSecret = getSessionSecret();
  const passwordHash = getDashboardPasswordHash();
  if (!sessionSecret || !passwordHash) {
    console.error("[auth/login] SESSION_SECRET ou DASHBOARD_PASSWORD_HASH ausente/inválido — login indisponível até configurar.");
    return NextResponse.json({ error: "auth_not_configured" }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const password = typeof body?.password === "string" ? body.password : null;

  const rateLimitKey = deriveRateLimitKey(request, sessionSecret);

  // FAIL_CLOSED (item 13, CRÍTICO): qualquer erro checando o rate limit
  // (DB indisponível, etc.) é tratado como bloqueado — nunca deixa a
  // tentativa passar só porque o enforcement autoritativo falhou. Copy da
  // resposta é a MESMA de "bloqueado normal" (item 49 — nunca revela que
  // o backend de rate limit teve um erro interno).
  let blockedState;
  try {
    blockedState = await isBlocked(rateLimitKey);
  } catch (err) {
    console.error("[auth/login] rate limit check falhou (DB indisponível?) — fail-closed, tratando como bloqueado.", err);
    return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
  }
  if (blockedState.blocked) {
    return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
  }

  const ok = password != null && verifyPassword(password, passwordHash);
  if (!ok) {
    try {
      await recordFailure(rateLimitKey);
    } catch (err) {
      // Mesma disciplina fail-closed: se não conseguimos REGISTRAR a falha,
      // ainda assim negamos esta tentativa (nunca permite login sem prova
      // de que o contador foi incrementado) — mas devolve o erro genérico
      // de credencial errada, não 429 (a tentativa em si não foi bloqueada
      // por limite, foi rejeitada por senha errada; só o registro falhou).
      console.error("[auth/login] falha ao registrar tentativa incorreta no rate limiter.", err);
    }
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  try {
    await clearAttempts(rateLimitKey);
  } catch (err) {
    // Login já é válido — não bloquear o usuário legítimo por uma falha ao
    // limpar o contador; só loga. Pior caso: a próxima janela de tentativas
    // desse IP começa de um count não-zerado, nunca um bloqueio indevido.
    console.error("[auth/login] falha ao limpar contador de rate limit após login bem-sucedido.", err);
  }

  const session = await createSessionToken(sessionSecret);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, session.token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: "lax",
    path: "/",
    maxAge: session.exp - Math.floor(Date.now() / 1000),
  });
  return res;
}
