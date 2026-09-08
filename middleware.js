import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import { getSessionSecret, isDevBypassEnabled, isProductionRuntime } from "@/lib/auth/envConfig";
import { isSameOriginMutation } from "@/lib/auth/origin";

// Fase 5.3C, blueprint item 11 — proteção server-side cobrindo app/** E
// app/api/** (uma rota de API é acessível direto, sem passar pela tela — só
// proteger componentes React não basta). DENY BY DEFAULT: tudo que não está
// na allowlist abaixo exige sessão válida.
//
// Allowlist explícita (nunca "bloqueia tudo exceto o que eu lembrar depois"):
//   - /login (a própria tela de login — sem isso, ninguém consegue logar);
//   - /api/auth/login e /api/auth/logout (a mutação que cria/apaga a sessão);
//   - /api/telegram/webhook (protegido por mecanismo PRÓPRIO — secret header +
//     allowlist de chatId, nunca cookie de sessão web; ver route.js);
//   - assets estáticos do Next (_next/*, favicon.ico) e o matcher abaixo já
//     exclui a maioria disso por padrão.
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/logout"]);
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isPublicPath(pathname) {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname === "/api/telegram/webhook") return true;
  return false;
}

function jsonError(status, error) {
  // Item 16 — nunca vaza detalhe (stack, env, secret) na resposta; mensagem
  // mínima e genérica sempre.
  return NextResponse.json({ error }, { status });
}

export async function middleware(request) {
  const { pathname } = request.nextUrl;
  const isApiPath = pathname.startsWith("/api/");

  if (isPublicPath(pathname)) return NextResponse.next();

  // Item 24 — bypass SOMENTE em dev, SOMENTE explícito, NUNCA em produção
  // (isDevBypassEnabled() já retorna false incondicionalmente em produção).
  if (isDevBypassEnabled()) return NextResponse.next();

  const sessionSecret = getSessionSecret();
  if (!sessionSecret) {
    // Item 14/23 — segredo ausente/malformado: FAIL CLOSED sempre, produção
    // ou dev (a única forma de abrir mão disso em dev é o bypass explícito
    // acima). Nunca "abre a rota porque não tem como validar".
    console.error(
      `[middleware] SESSION_SECRET ausente ou inválido (precisa de 64+ chars hex) — negando acesso a ${pathname}. ` +
        (isProductionRuntime() ? "Configure a env var na Vercel." : "Rode: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" e configure SESSION_SECRET no .env, ou AUTH_DEV_BYPASS=true só pra dev local.")
    );
    return isApiPath ? jsonError(500, "auth_not_configured") : NextResponse.redirect(new URL("/login", request.url));
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(token, sessionSecret);
  if (!session) {
    return isApiPath ? jsonError(401, "unauthorized") : NextResponse.redirect(new URL("/login", request.url));
  }

  // Item 8/9 — CSRF/origin check só pra mutações autenticadas (GET nunca
  // muda estado, não precisa). Aplica a TODAS as rotas de mutação de
  // app/api/** por igual (não é preciso listar rota por rota).
  if (isApiPath && MUTATION_METHODS.has(request.method) && !isSameOriginMutation(request)) {
    return jsonError(403, "invalid_origin");
  }

  return NextResponse.next();
}

// Roda em tudo, exceto assets estáticos do Next (nunca precisam de auth e não
// custodiam nada sensível).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
