# Arquitetura final — Norte (financas-dashboard)

Status: produto V2-only, ciclo de fases 5.4B→5.4F.1 encerrado (limpeza/aceite
final). Este documento é a referência arquitetural corrente — não um
histórico de fase, não um relatório de conversa. Para o racional histórico
de cada decisão, ver `docs/schema-v2-blueprint.md` (proposta original do
schema V2), `docs/dev-environment.md` (setup local/dev-prod boundary),
`docs/fase53c-prod-config-manifest.md` (variáveis de produção esperadas).

Nenhum valor financeiro pessoal, nome pessoal, ID real ou secret aparece
neste documento.

## 1. Produto é V2-only

Não existe mais nenhum consumidor ativo, user-facing, de verdade financeira
V1. A cadeia V1 (`lib/indicators.js`, `lib/intelligence.js`, `lib/alerts.js`,
`lib/cashFlowProjection.js`) foi removida na Fase 5.4F após confirmação de
zero-caller real (grep completo de imports/rotas/testes, documentado no
relatório da fase). `LegacyTransaction` continua existindo como tabela
histórica congelada, somente leitura (`app/api/transactions/route.js`) — é
arquivo, não verdade financeira ativa.

## 2. Route ownership (superfícies canônicas)

| Rota | Responde | Fonte |
|---|---|---|
| `/` (Home) | Como eu tô? Quanto tenho/está livre/é seguro gastar? | `/api/dashboard` → `lib/productFinancialSnapshot.js` |
| `/cartoes` | Crédito, faturas, uso de limite | `/api/dashboard` + `/api/cards/[id]/bills` |
| `/compromissos` | Obrigações, parcelas externas, riscos | `/api/dashboard` |
| `/fluxo` | Projeção de caixa (30/60/90, cenários) | `/api/cash-flow` → `lib/financialProjection.js` |
| `/historico` | Movimentos por ciclo/categoria | `/api/dashboard` (entries filtradas) |
| `/simulador` | Hipótese ("e se?") | `/api/simulate` → `lib/simulation/financialSimulator.js` |
| `/metas` | Metas de poupança pessoal (Goals) — escopo reduzido na Fase 5.4F | `/api/goals` |

Redirects de compatibilidade (single-hop, sem loop): `/parcelas` e
`/contas-a-pagar` → `/compromissos`; `/fluxo-caixa` → `/fluxo`;
`/indicadores` → `/` (Home é o ponto de reorientação mais honesto pro
conteúdo antigo de Indicadores, que foi removido — ver Fase 5.4F.1).

Nenhuma informação financeira crítica tem dois "primary owners" —
cada pergunta do produto (ver seção 4) tem uma superfície primária única.

## 3. Fonte única de verdade financeira

Toda métrica financeira do produto passa por `lib/productFinancialSnapshot.js`,
que compõe (nunca duplica) os helpers canônicos:

- `lib/unrestrictedCash.js` — caixa não-restrito (exclui VA)
- `lib/vaPanel.js` — Vale Alimentação (restrito)
- `lib/freeMoney.js` — dinheiro livre, próxima renda comprometida, exposição
  de contingência
- `lib/financialStatus.js` — situação financeira (Tranquilo/Atenção/
  Apertado/Crítico) e "seguro pra gastar"
- `lib/obligationClassifier.js` — classificação de obrigação (incorrida,
  horizonte atual, futura, contingência, liquidada, cancelada)
- `lib/cardBillCalculator.js` — faturas de cartão (leitura vs. mutação
  claramente separadas: `getCardBillView`/`listCardBillsView` nunca
  escrevem; `getOrCreateBill`/`payBill`/`anticipateBill` são as únicas
  mutações)
- `lib/externalInstallments.js` — parcelas externas e seu runoff
- `lib/financialProjection.js` — motor de projeção único (base/expected/
  stress), única fonte pra Fluxo, Home ("Como fico") e Simulador
- `lib/financialCycle.js` — ciclo financeiro pessoal (24→23 por padrão)

Nenhum componente/rota reimplementa fórmula financeira — auditado
explicitamente na Fase 5.4F (zero fórmula duplicada encontrada nos arquivos
ativos).

## 4. As perguntas que o produto responde

Como eu tô? · Quanto tenho de verdade? · Quanto está comprometido? · Quanto
está livre? · Quanto é seguro gastar? · Onde foi meu dinheiro? · O que vence
antes da próxima renda? · Quanto da próxima renda já está comprometido? ·
Quando minhas parcelas aliviam? · Como fico em 30/60/90? · Posso comprar X?
· Quanto tenho de VA? — cada uma com superfície primária e fonte canônica
únicas (mapa completo no relatório da Fase 5.4F).

## 5. Simulação — compute-only, nunca verdade

`lib/simulation/financialSimulator.js` é um overlay puro sobre os helpers
canônicos da seção 3 — nunca reimplementa fórmula, nunca escreve no banco
(`zeroWriteProof` no retorno de toda simulação). Os 4 cenários canônicos são
fixos: `CASH_EXPENSE_NOW`, `CARD_PURCHASE_SINGLE`,
`CARD_PURCHASE_INSTALLMENTS`, `CONTINGENCY_REALIZATION`.

**FACT vs HYPOTHESIS** é uma regra de produto, não só visual: o resultado
simulado nunca se mistura ao estado real — reforçado por label permanente
("Cenário simulado"), estrutura própria (nunca reaproveita o layout de
nenhuma página de dado real) e, no `/simulador`, uma atmosfera visual sutil
(`AnimatedGradient`, `--color-hypothetical`) que nunca compete com números
reais e é puramente decorativa (reduced-motion e ausência de WebGL caem de
volta pra uma superfície estática, sem perda de informação).

**CARD_FEASIBILITY nunca vira BUDGET_SAFETY**: a UI nunca deixa "o cartão
autorizaria" implicar "cabe no orçamento" — os dois vereditos são sempre
mostrados separados, mesmo quando um deles é positivo e o outro não.

**Entrada contextual** (de `/cartoes` ou `/compromissos` pro Simulador via
query params) só faz *prefill* — nunca auto-executa. Query params são só
roteamento de apresentação (tipo de cenário + IDs), sempre validados contra
dado real já buscado antes de preencher qualquer campo; nunca JSON
financeiro bruto na URL.

## 6. Semântica de data

Datas de calendário (vencimento, fechamento, previsão) são meia-noite UTC e
formatadas sem forçar timezone local (evita deslocamento de um dia em fusos
negativos). Timestamps reais (`occurredAt`/`createdAt`) usam fuso local
normalmente. `APP_TIMEZONE` (default `America/Sao_Paulo`) resolve "hoje" em
linguagem natural no Telegram.

## 7. Parcelas externas — AFTER_NEXT_INCOME

O runoff de parcelas externas nunca inventa data de calendário — é
posicional (uma parcela de cada plano ativo por *ocorrência* de renda: "cai
na próxima renda", "+1 renda", "+2 rendas"...), nunca "dia X do mês Y".
`lib/externalInstallments.js` é a única fonte.

## 8. Gaps de dado conhecidos (aceitos, não mascarados)

- **KNOWN_CARD_DETAIL_GAP** = `ACCEPTED_DATA_QUALITY_GAP`: o total
  autoritativo de uma fatura (`CardBill.totalAmount`, reconciliado com o
  banco real) pode exceder o que é explicável pelos lançamentos
  individualmente persistidos. Nunca sobrescrito, nunca tratado como erro —
  a UI mostra uma nota discreta ("R$X ainda sem detalhamento individual"),
  o total real nunca muda.
- **Historical ledger**: dados anteriores ao snapshot de reconciliação
  (pré-migração) são **PARTIAL** por natureza — nunca "fechados" com
  lançamento fabricado. Dados pós-snapshot são **CONFIRMED**.

## 9. Modelo de segurança

- **Web**: cookie de sessão assinado (HMAC), `HttpOnly`, `SameSite=Lax`;
  CSRF/Origin guard em toda rota de mutação; middleware fail-closed
  (nega por padrão, autentica explicitamente).
- **Telegram**: identidade via `from.id` (nunca `chat.id`), allowlist
  (`TELEGRAM_ALLOWED_USER_ID`), secret de webhook
  (`TELEGRAM_WEBHOOK_SECRET`) validado antes de qualquer processamento,
  restrição a chat privado, idempotência via `TelegramUpdateReceipt`
  (mesmo `update_id` nunca reprocessado, mesmo sob concorrência).
- **Rate limit** (login) — Fase 5.5: SERVIDOR-AUTORITATIVO, em Postgres
  (`LoginRateLimit`, mesmo banco de tudo — zero provider novo). Substitui o
  contador só-em-cookie da Fase 5.3C, cujo achado real da 5.4F.1 era
  `CLIENT_RESET_RESISTANT=NO`. Propriedades:
  - Chave nunca é o IP em texto puro: `HMAC-SHA256(scope + IP,
    SESSION_SECRET)` — mesmo segredo já exigido pelo resto do sistema de
    auth, zero credencial nova. IP lido de `x-vercel-forwarded-for` (mais
    confiável na Vercel — nunca sobrescrito mesmo com proxy na frente) com
    fallback pra `x-forwarded-for` (também confiável na Vercel — a borda
    sobrescreve e nunca repassa IP externo forjado).
  - Incremento atômico via `INSERT ... ON CONFLICT DO UPDATE SET count =
    count + 1` (lock de linha do Postgres — imune a race condition sob
    concorrência real; verificado por teste de 8 requisições simultâneas,
    `scripts/test-security-ratelimit.mjs`).
  - `blockedUntil` monotonicamente não-decrescente sob concorrência via
    `GREATEST(...)` — uma resposta mais antiga nunca enfraquece um bloqueio
    mais severo já gravado por uma mais recente.
  - **FAIL_CLOSED**: se o check de rate limit falhar (ex: banco
    indisponível), a tentativa é tratada como BLOQUEADA — nunca cai pra
    "sem limite". Nenhum caminho de sucesso (`createSessionToken`) executa
    antes do check de rate limit.
  - Nenhum cookie de rate limit existe mais — `CLIENT_RESET_RESISTANT=YES`
    por construção (o estado nunca esteve no cliente pra começo de
    conversa), verificado por teste de aceitação dedicado (cenário [C] de
    `scripts/test-security-ratelimit.mjs`: sequência inteira sem nenhum
    Cookie enviado ou recebido, bloqueio ocorre normalmente).
  - Sem branch por ambiente dentro do módulo (`lib/auth/rateLimitDb.js`) —
    mesmo enforcement em dev e produção, nada de fallback client-resettable
    residual a guardar.
  - `lib/auth/rateLimit.js` (o limitador antigo em cookie) foi REMOVIDO
    nesta fase — decisão explícita de não manter como defense-in-depth
    (duas máquinas de estado independentes seria complexidade real por um
    ganho marginal, já que o novo enforcement é autoritativo e
    fail-closed).

## 10. Fronteira dev/produção

`DATABASE_URL` local aponta pro branch **dev** do Neon, nunca pra produção
(branch `main`). Todo script de teste passa por `assertTestEnvironment()`
(fail-closed: aborta se `DATABASE_ENV` não for `development`/`test`).
Produção só existe como variável de ambiente na Vercel — nunca em arquivo
`.env` local. Ver `docs/dev-environment.md` pro procedimento de setup
completo (inclui `DIRECT_URL`, adicionado na Fase 5.4F.1).

## 11. Blockers conhecidos de pré-produção

| Item | Tipo | Status |
|---|---|---|
| Rate limit não resistente a reset pelo cliente | INFRASTRUCTURE | **RESOLVIDO na Fase 5.5** — enforcement server-authoritative em Postgres, ver seção 9 |
| Variáveis de ambiente de produção (Vercel) | CONFIGURATION | `BLOCKED_BY_EXTERNAL_ACCESS` — sem sessão Vercel autenticada nesta máquina/sessão (`vercel whoami` confirmado sem token válido, Fase 5.5). Verificação real exige: dono da conta rodar `vercel env ls production` (ou abrir o dashboard) e confirmar presença/consistência de `SESSION_SECRET`, `DASHBOARD_PASSWORD_HASH`, `DATABASE_URL`, `DIRECT_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_ID` — nomes apenas, nunca valores |
| `DIRECT_URL` em produção | CONFIGURATION | `BLOCKED_BY_EXTERNAL_ACCESS` — mesma verificação acima |
| Backup/PITR do branch de produção (Neon) | INFRASTRUCTURE | `BLOCKED_BY_EXTERNAL_ACCESS` — `neonctl` exige OAuth interativo no navegador (confirmado, timeout de autenticação na Fase 5.5); dono da conta precisa confirmar no console Neon se PITR está habilitado pro branch `main` e qual a janela de retenção |
| Domínio/HTTPS de produção (Vercel) | CONFIGURATION | `BLOCKED_BY_EXTERNAL_ACCESS` — mesma causa do item de env vars |
| Telegram: token/webhook de produção (`getWebhookInfo` read-only) | INFRASTRUCTURE | `BLOCKED_BY_EXTERNAL_ACCESS` — nem token de bot está disponível nesta sessão (confirmado ausente até do `.env` local de dev); só o dono, com o token real, pode rodar a checagem read-only |
| Telegram: leitura dedicada de 30/60/90 | PRODUCT_DEFERRED | não implementado, non-blocking |
| `npm audit`: 16 vulnerabilidades em 4 cadeias de dependência | INFRASTRUCTURE | Auditado com matriz de risco na Fase 5.5 (ver relatório da fase) — 13/16 têm fix não-destrutivo disponível (não aplicado nesta fase, pendente de autorização); 3/16 (uuid/@cypress/request/node-telegram-bot-api) só via upgrade major do `node-telegram-bot-api` (0.66→2.x, breaking change) — `ACCEPTED_TEMPORARY_RISK`, migração é fase própria |

Nenhum destes é um defeito de código — são gaps de infraestrutura/config
externa ou escopo deliberadamente adiado, documentados em vez de mascarados.

## 12. Setup local

Ver `docs/dev-environment.md`.
