// Fase 5.3D.1 — timezone central do app. Usada pra resolver linguagem
// natural de data ("hoje"/"ontem"/dia da semana) na timezone LOCAL do
// usuário, nunca a data-calendário UTC crua do servidor (bug real corrigido
// nesta fase — ver lib/naturalDate.js:resolveEconomicDate).
//
// Env var (mesmo padrão de config server-side já estabelecido no projeto —
// SESSION_SECRET, TELEGRAM_ALLOWED_USER_ID, AUTH_DEV_BYPASS: nunca um valor
// espalhado/hardcoded em dezenas de arquivos). Não é segredo — é config de
// apresentação, mesma categoria de "pt-BR"/"BRL" já hardcoded no app inteiro
// (lib/formatMoney.js). Default documentado, coerente com o resto do app
// (pt-BR/BRL em todo lugar): America/Sao_Paulo.
const DEFAULT_TIMEZONE = "America/Sao_Paulo";

export function getAppTimezone() {
  return process.env.APP_TIMEZONE || DEFAULT_TIMEZONE;
}

// localCalendarDateAsUtcMidnight(instant, timeZone) -> Date (UTC meia-noite)
//
// Converte um INSTANT (um ponto exato no tempo — ex: new Date(), sempre
// timezone-agnostic internamente, só um número de ms desde epoch) pra "que
// DIA CALENDÁRIO é isso na timezone local", e representa esse dia como
// meia-noite UTC — a MESMA convenção de armazenamento de data-calendário já
// usada no resto do app (ver lib/formatMoney.js: "Datas de calendário são
// guardadas como meia-noite UTC"). A ÚNICA coisa que muda é COMO o dia é
// determinado a partir do instant — antes (bug): date.getUTCDate() cru, que
// já pode pertencer ao dia SEGUINTE em UTC pra qualquer horário à noite num
// fuso negativo (Brasil). Agora: usa Intl.DateTimeFormat com a timezone IANA
// configurada — suporte nativo do runtime, sem offset manual fixo (item 10:
// nunca "UTC-3" hardcoded — isso quebraria em qualquer mudança de regra de
// fuso; a API de Intl/timezone IANA já resolve isso corretamente).
export function localCalendarDateAsUtcMidnight(instant, timeZone = getAppTimezone()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const year = Number(parts.find((p) => p.type === "year").value);
  const month = Number(parts.find((p) => p.type === "month").value);
  const day = Number(parts.find((p) => p.type === "day").value);
  return new Date(Date.UTC(year, month - 1, day));
}
