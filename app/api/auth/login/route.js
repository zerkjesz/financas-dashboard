import { NextResponse } from "next/server";
import { verifyPassword } from "@/lib/auth/password";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { readAttemptState, isBlocked, recordFailure, RATE_LIMIT_COOKIE_NAME } from "@/lib/auth/rateLimit";
import { getDashboardPasswordHash, getSessionSecret, shouldUseSecureCookie } from "@/lib/auth/envConfig";

// Fase 5.3C — única rota fora da allowlist de middleware.js que aceita
// requisição sem sessão (é o próprio login). Item 16: toda resposta de erro
// é uma mensagem mínima e genérica — nunca vaza se foi "senha errada" vs
// "config ausente" de forma que ajude um atacante a distinguir, além do
// necessário pro usuário legítimo entender o que fazer.
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

  const attemptsCookie = request.cookies.get(RATE_LIMIT_COOKIE_NAME)?.value;
  const state = await readAttemptState(attemptsCookie, sessionSecret);
  if (isBlocked(state)) {
    return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
  }

  const ok = password != null && verifyPassword(password, passwordHash);
  if (!ok) {
    const newAttemptsCookie = await recordFailure(state, sessionSecret);
    const res = NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    res.cookies.set(RATE_LIMIT_COOKIE_NAME, newAttemptsCookie, {
      httpOnly: true,
      secure: shouldUseSecureCookie(),
      sameSite: "lax",
      path: "/",
      maxAge: 3600,
    });
    return res;
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
  res.cookies.delete(RATE_LIMIT_COOKIE_NAME);
  return res;
}
