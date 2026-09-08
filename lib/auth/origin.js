// Fase 5.3C, item 8/9 — CSRF/origin check pra rotas de mutação protegidas por
// cookie. Como a sessão é um cookie (enviado automaticamente pelo browser em
// qualquer request, inclusive cross-site), SameSite sozinho já mitiga a
// maioria dos browsers modernos, mas validar Origin/Host é defesa em
// profundidade barata e recomendada — sem token CSRF novo pra gerenciar
// (mais infra/estado pra um app pessoal single-user).
//
// Regra: se o header Origin estiver presente (é o caso normal de fetch()
// same-origin do próprio frontend), ele precisa bater com o Host da própria
// request. Sem Origin (alguns clientes non-browser não mandam) cai no
// fallback de comparar Referer; se nenhum dos dois existir, NEGA por padrão
// pra mutation routes (fail closed) — nunca aceita "sem informação" como
// "confio".
export function isSameOriginMutation(request) {
  const host = request.headers.get("host");
  if (!host) return false;

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).host === host;
    } catch {
      return false;
    }
  }

  return false; // nem Origin nem Referer — fail closed.
}
