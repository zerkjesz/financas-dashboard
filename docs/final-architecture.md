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
  - **MISSING TRUSTED IP** (Fase 5.5.1): quando não há header de IP
    confiável (`x-vercel-forwarded-for` / `x-forwarded-for`),
    `deriveRateLimitKey` retorna `null` em **produção** — e o handler trata
    `null` como bloqueio (FAIL_CLOSED, 429 antes de qualquer verificação de
    senha), nunca cai num bucket global compartilhado. Só em
    desenvolvimento existe um bucket sintético de conveniência
    (`dev-local-no-ip`), guardado por `isProductionRuntime()` — nunca ativo
    em produção. Na prática o FAIL_CLOSED quase nunca dispara: a Vercel
    sempre seta `x-forwarded-for` pra tráfego real que passa pela borda
    dela; `null` significaria requisição chegando por um caminho anômalo.
  - **STORAGE BOUNDEDNESS** (Fase 5.5.1): a expiração da janela (1h) é
    lógica; a limpeza FÍSICA é feita por `sweepExpired()` — um único
    `DELETE ... WHERE ctid IN (SELECT ctid ... LIMIT 100)`, oportunista (a
    cada `recordFailure`), atômico e BOUNDED (nunca full-table delete numa
    request de login), best-effort (um erro na limpeza nunca afeta a
    decisão de rate limit). Sem isso, cada IP distinto que errasse o login
    uma vez deixaria uma linha permanente (storage amplification sob ataque
    distribuído). `clearAttempts` (login bem-sucedido) já remove a linha
    fisicamente.
  - **DISTRIBUTED_ROTATING_IP_RESISTANCE = NO** (risco residual aceito):
    rate limit por IP não impede um atacante com muitos IPs distintos. Para
    um app pessoal single-user isso é risco residual aceitável — o segredo
    real é um hash `scrypt` de uma senha que só o dono conhece, e
    fingerprint invasivo / WAF novo seria desproporcional. Documentado, não
    mascarado.
  - `lib/auth/rateLimit.js` (o limitador antigo em cookie) foi REMOVIDO
    nesta fase — decisão explícita de não manter como defense-in-depth
    (duas máquinas de estado independentes seria complexidade real por um
    ganho marginal, já que o novo enforcement é autoritativo e
    fail-closed).
  - **Camadas de prontidão** (não colapsar num único "pronto"):
    `RATE_LIMIT_CODE_READY = YES` · `RATE_LIMIT_SCHEMA_READY_IN_DEV = YES`
    (migration `20260909184113_login_rate_limit` aplicada no branch dev) ·
    `RATE_LIMIT_SCHEMA_READY_IN_PRODUCTION = NO` (produção não tem a tabela
    — ver seção 11) · `RATE_LIMIT_PRODUCTION_READY = NO / CONDITIONAL_ON_MIGRATION`.

## 10. Fronteira dev/produção

`DATABASE_URL` local aponta pro branch **dev** do Neon, nunca pra produção
(branch `main`). Todo script de teste passa por `assertTestEnvironment()`
(fail-closed: aborta se `DATABASE_ENV` não for `development`/`test`).
Produção só existe como variável de ambiente na Vercel — nunca em arquivo
`.env` local. Ver `docs/dev-environment.md` pro procedimento de setup
completo (inclui `DIRECT_URL`, adicionado na Fase 5.4F.1).

## 11. Blockers conhecidos de pré-produção

Estado após a Fase 5.5.1 (inspeção read-only real de Neon + do deployment
de produção; Vercel/Telegram continuam sem acesso autenticado).

| Item | Tipo | Status |
|---|---|---|
| Rate limit não resistente a reset pelo cliente | INFRASTRUCTURE | **RESOLVIDO (código)** na Fase 5.5/5.5.1 — enforcement server-authoritative + bounded + fail-closed em Postgres, ver seção 9. Depende de migration em produção (linha abaixo). |
| **Produção roda código PRÉ-AUTENTICAÇÃO (pré-V2)** | CODE_DEPLOYMENT | **CRÍTICO, PENDENTE.** `origin/main` está 61 commits atrás do local. Inspeção read-only de `https://financas-dashboard-omega.vercel.app` na Fase 5.5.1: `/login` → 404, `/api/dashboard` → **200 com payload financeiro completo, SEM autenticação**. Toda a camada de auth (Fases 5.3C+) e toda a arquitetura V2 (Fases 5.1–5.5) nunca foram para produção. A API financeira de produção está pública. Corrigido só pelo cutover da Fase 5.6 (deploy do bundle de 61 commits). |
| **Produção está 7 migrations atrás** | PENDING_PRODUCTION_MIGRATION | `prisma migrate status` read-only contra o branch `production` do Neon (Fase 5.5.1): só as 5 primeiras migrations aplicadas. Pendentes: `convert_money_fields_to_decimal` (Float→Decimal, TYPE CHANGE — precisa re-rodar a auditoria da Fase 3.0 contra os dados REAIS de produção antes do cutover), `appsettings_dataconfidence`, `domain_models_v2`, `income_recurring_occurrence_date`, `external_installment_due_timing`, `telegram_update_receipt`, `login_rate_limit`. 6 das 7 são estritamente aditivas/seguras; só a de Decimal exige validação prévia. Ordem já correta (timestamp-prefix). Aplicar via `prisma migrate deploy` no cutover — nunca antes. |
| Variáveis de ambiente de produção (Vercel) | CONFIGURATION | `BLOCKED_BY_EXTERNAL_ACCESS` — `vercel whoami` → "Logged out" (Fase 5.5.1). Exige `vercel login` do dono + `vercel env ls production` pra confirmar `SESSION_SECRET`, `DASHBOARD_PASSWORD_HASH`, `DATABASE_URL`, `DIRECT_URL`, `TELEGRAM_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_ID` presentes; e `AUTH_DEV_BYPASS` ausente/falsy, `DATABASE_ENV` semanticamente de produção (ambos são STOP/CRITICAL se errados) — nomes apenas, nunca valores |
| Backup/PITR do branch de produção (Neon) | INFRASTRUCTURE | **PARCIALMENTE VERIFICADO** (Fase 5.5.1, `neonctl` read-only): projeto `cool-firefly-30627522`, `history_retention_seconds = 21600` → **PITR de 6h** (default de plano gratuito). O branch `production` (`br-soft-feather-actl671r`) NÃO está marcado como `protected` — sem guarda contra reset/delete acidental. Recomendação pré-cutover: criar um branch-snapshot manual de produção como ponto de restauração explícito (a janela de 6h é curta pra um cutover). |
| Fronteira dev/produção (Neon) | CONFIGURATION | **VERIFICADO OK** (Fase 5.5.1): `.env` local aponta pro endpoint `ep-polished-queen-…` = branch **dev** (`br-square-glitter-…`). Branch `production` usa endpoint distinto (`ep-odd-lab-…`), nunca presente em `.env` local. Produção sem escrita desde 2026-09-05. |
| Domínio/HTTPS de produção (Vercel) | CONFIGURATION | **PARCIALMENTE VERIFICADO** (Fase 5.5.1, 1 GET read-only): `https://financas-dashboard-omega.vercel.app` responde HTTP/2, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `server: Vercel`. HTTPS OK. Config de domínio/projeto (branch de produção, build settings) continua `BLOCKED_BY_EXTERNAL_ACCESS`. |
| Telegram: token/webhook de produção (`getWebhookInfo` read-only) | INFRASTRUCTURE | `BLOCKED_BY_EXTERNAL_ACCESS` — token de bot não disponível nesta sessão (ausente do `.env` local; produção exige acesso Vercel). Só o dono, com o token real, roda `getWebhookInfo` (read-only). |
| Telegram: leitura dedicada de 30/60/90 | PRODUCT_DEFERRED | não implementado, non-blocking |
| `npm audit`: dependências | ACCEPTED_DEPENDENCY_RISK | Fase 5.5.1: **2 RCE críticas do Next.js RESOLVIDAS** (`next` 15.5.21→15.5.25, patch, dentro de `^15.5.0`; build limpo + 42/42 testes). Restam 16 avisos, todos em cadeias não-alcançáveis pelo runtime: cadeia `request`/`@cypress/request`/`node-telegram-bot-api` (form-data CRLF, request SSRF — bot só manda texto pra URL fixa `api.telegram.org`, zero multipart, zero fetch de URL arbitrária) só corrigível via upgrade major `node-telegram-bot-api` 0.66→2.x (fase própria); `postcss`/`nanoid` (build-time, nunca processa input de atacante); `deepmerge-ts`/`prisma` (CLI devDependency, nunca no runtime); `sharp` (CLI + zero uso de `next/image`). `ACCEPTED_TEMPORARY_RISK` documentado por cadeia. |

Nenhum item deste bloco é um defeito de código introduzido nesta fase — são
gaps de deploy/config/infra externa (produção nunca recebeu o trabalho das
Fases 5.1–5.5) ou risco de dependência classificado, documentados em vez de
mascarados.

## 12. Setup local

Ver `docs/dev-environment.md`.
