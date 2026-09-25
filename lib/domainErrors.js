// Fase 9.1 — erros de domínio com `code` estável: as rotas HTTP mapeiam code -> status sem
// depender de texto de mensagem (STALE/ALREADY_* = 409, NOT_FOUND = 404, INVALID = 400, ...).
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export const DOMAIN_ERROR_STATUS = Object.freeze({
  INVALID: 400,
  INSUFFICIENT_FUNDS: 422,
  OUT_OF_ORDER: 422,
  NOT_FOUND: 404,
  STALE: 409,
  ALREADY_PAID: 409,
  NOT_PAID: 409,
});

export function domainErrorStatus(error) {
  return error instanceof DomainError ? (DOMAIN_ERROR_STATUS[error.code] ?? 400) : null;
}
