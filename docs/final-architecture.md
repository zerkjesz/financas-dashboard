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
  - **STORAGE — retenção time-bounded + GC eventual, NÃO hard bound**
    (Fase 5.5.2, corrigindo o overclaim da 5.5.1): a expiração da janela
    (1h) é lógica; a limpeza FÍSICA é `sweepExpired()` — um único
    `DELETE ... WHERE ctid IN (SELECT ctid ... LIMIT 100)`, oportunista (a
    cada `recordFailure`), atômico, best-effort. `clearAttempts` (login OK)
    remove a linha fisicamente.
    - `HARD_STORAGE_BOUND` = **NÃO**. Num flood distribuído, N IPs numa
      janela de 1h criam até N linhas antes de qualquer expirar.
    - `DELETE_BATCH_BOUND` = 100/chamada (hard).
    - `ROTATING_IP_STORAGE_AMPLIFICATION` existe (~150 B/IP/h; drena
      quando o flood para). Resíduo aceito pra app pessoal — mesma
      categoria de `DISTRIBUTED_ROTATING_IP_RESISTANCE`.
    - Performance (EXPLAIN ANALYZE real, branch dev do Neon): ~1,5 ms a 20
      linhas, ~2,3 ms a 20k linhas no caso degenerado (todos os buffers em
      cache). NÃO justifica índice nessa escala — um índice em
      `windowStart` pagaria amplificação de escrita em todo upsert. Fix
      mínimo se algum dia >100k linhas vivas:
      `CREATE INDEX ON "LoginRateLimit"("windowStart") WHERE "blockedUntil" IS NULL`.
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

Estado após a Fase 5.5.4. **`FASE_5_5_PREPRODUCTION_INFRA_READY = YES`** —
não há mais `HUMAN_ACTION_REQUIRED` pendente. Tudo abaixo marcado
`PENDING_CUTOVER_MIGRATION` / `PENDING_CUTOVER` é trabalho da Fase 5.6
(cutover), com plano pronto em `docs/fase55-cutover-plan.md`.

| Item | Tipo | Status |
|---|---|---|
| Rate limit não resistente a reset pelo cliente | INFRASTRUCTURE | **RESOLVIDO (código)** — server-authoritative + fail-closed + missing-IP-fail-closed + GC eventual bounded, ver seção 9. Depende de migration em produção (linha abaixo). |
| **Exposição: dashboard/API financeira de produção acessível anonimamente** | SECURITY_INCIDENT | **CONTIDO na Fase 5.5.2.** Antes: `GET /api/dashboard` → 200 com payload financeiro, sem auth (produção roda código pré-auth). Contenção: Vercel Deployment Protection (`ssoProtection.deploymentType = "all"`) habilitado via API. Depois: `GET /` e `/api/dashboard` (anônimo) → **302 → `vercel.com/sso-api` → `vercel.com/login`**; `POST /api/telegram/webhook` (anônimo) → **401**. Nenhum payload financeiro servido anonimamente. Detalhe: `docs/fase552-production-containment.md`. Fix permanente = cutover V2/auth (5.6). |
| **Produção roda código PRÉ-AUTENTICAÇÃO (pré-V2)** | CODE_DEPLOYMENT | `origin/main` 61 commits atrás. Toda a auth (5.3C+) e V2 (5.1–5.5) nunca deployadas. Contido (linha acima); corrigido de vez só pelo cutover 5.6. |
| **Produção está 7 migrations atrás** | PENDING_CUTOVER_MIGRATION | `prisma migrate status` read-only contra `production` (5.5.1, re-confirmado 5.5.2): 5 aplicadas. `PENDING_MIGRATION_RISK_MATRIX` (5.5.2): 6/7 estritamente aditivas (só `ADD COLUMN` nullable / `CREATE TABLE` vazia / `DROP NOT NULL`); a 7ª, `convert_money_fields_to_decimal` (Float→Decimal, 17 colunas), **auditada contra os dados REAIS de produção**: 0 NaN/Inf, 0 overflow de `DECIMAL(12,2)` (máx valor 4937.18), **0 linhas alteradas por ROUND, maxΔ=0.00** → `PRODUCTION_DECIMAL_MIGRATION_SAFE = YES`. Ordem correta. Aplicar via `prisma migrate deploy` só no cutover. |
| Variáveis de ambiente de produção (Vercel) | CONFIGURATION | **COMPLETO (5.5.2 → 5.5.4)** — todas as 9 vars requeridas PRESENTES, type `sensitive`, sem efeito no deployment atual (env só vale no próximo build). `DATABASE_URL` (49d), `TELEGRAM_TOKEN` (49d), `DIRECT_URL` (Neon endpoint `production` unpooled — mesmo string do audit read-only da 5.5.2), `DATABASE_ENV=production`, `APP_TIMEZONE=America/Sao_Paulo` (5.5.2); `SESSION_SECRET` (`crypto.randomBytes(48)` → 96 hex), `DASHBOARD_PASSWORD_HASH` (`scrypt:…` via `lib/auth/password.js`, round-trip verificado; passphrase no macOS login keychain `norte-dashboard-prod`), `TELEGRAM_WEBHOOK_SECRET` (`crypto.randomBytes(32)` → 64 hex) (5.5.3); **`TELEGRAM_ALLOWED_USER_ID`** (5.5.4 — capturado via challenge `getUpdates`: o dono mandou `NORTE-VERIFY-…` pro bot, `from.id` extraído de update em chat privado, `isAuthorizedTelegramSender` do projeto validou; nunca impresso). `AUTH_DEV_BYPASS` **ausente = SEGURO**. `PRODUCTION_ENV_COMPLETE = YES`. |
| Backup/PITR do branch de produção (Neon) | INFRASTRUCTURE | **PITR 6h** (`history_retention_seconds=21600`). Branch protection: `BRANCHES_PROTECTED_LIMIT_EXCEEDED` — **indisponível no plano gratuito** (0 protected branches). Mitigação executada na 5.5.2: branch-snapshot manual **`pre-cutover-2026-09-10`** (`br-dark-sound-ac1j9voh`, sem endpoint, CoW, criado do `production` @ LSN `0/34B1B08` — não modifica dados do parent). |
| Fronteira dev/produção (Neon) | CONFIGURATION | **VERIFICADO OK**: `.env` local → endpoint `ep-polished-queen-…` = branch **dev**. Produção = `ep-odd-lab-…`, distinto. Produção sem escrita desde 2026-09-05 (só as leituras read-only desta fase depois disso). |
| Domínio/HTTPS de produção (Vercel) | CONFIGURATION | **VERIFICADO** (5.5.2, `vercel project` + API): projeto `financas-dashboard` (`prj_lgNaQ…`), framework `nextjs`, node `24.x`, production branch `main` (GitHub `zerkjesz/financas-dashboard`), `gitForkProtection: true`. HTTPS OK (HTTP/2, HSTS preload). Build/install/output commands = default. |
| Telegram: `getWebhookInfo` de produção | RESOLVIDO (5.5.3) | Executado read-only com o token do `.env` local (bot único; `getMe` confirmou token válido e ativo). **Resultado: NENHUM webhook configurado** (`WEBHOOK_CONFIGURED=false`, `pending_update_count=0`, sem erros). Não há webhook legado a preservar/reverter — no cutover, `setWebhook` é configuração inicial. `SENSITIVE_ENV_AVAILABLE_TO_ENV_RUN = NO` (provado: `vercel env run` diz "Secret values cannot be pulled"); no cutover, `setWebhook` roda de dentro de uma function deployada (que recebe `sensitive` em runtime) ou o dono roda manual. |
| Telegram: `TELEGRAM_CUTOVER_CAPABILITY` | **YES (5.5.4)** | `TELEGRAM_TOKEN` + `TELEGRAM_WEBHOOK_SECRET` + `TELEGRAM_ALLOWED_USER_ID` todos presentes em produção; estratégia de `setWebhook` documentada (§7 do cutover plan). `TELEGRAM_CURRENT_WEBHOOK_HEALTH = NO_WEBHOOK_CONFIGURED` (aceitável — `setWebhook` é inicial). |
| Telegram: disponibilidade durante contenção | ACCEPTED_TEMPORARY | `TEMPORARY_TELEGRAM_AVAILABILITY_DURING_CONTAINMENT` = OFFLINE_BY_CONTAINMENT (e não havia webhook mesmo). Deployment Protection responde 401 a qualquer POST no path. Aceito. |
| Telegram: leitura dedicada de 30/60/90 | PRODUCT_DEFERRED | não implementado, non-blocking |
| `npm audit`: dependências | ACCEPTED_DEPENDENCY_RISK | **2 RCE críticas do Next.js RESOLVIDAS** (`next` 15.5.21→15.5.25). Restam 16 avisos (2 critical, 6 high, 8 moderate) — nenhum alcançável pelo runtime: cadeia `request`/`@cypress/request`/`node-telegram-bot-api` (form-data CRLF, request SSRF — bot só manda texto pra URL fixa `api.telegram.org`) só via major 0.66→2.x (fase própria); `postcss`/`nanoid` (build-time); `deepmerge-ts`/`prisma` (CLI devDependency); `sharp` (zero `next/image`). Nenhum patch não-breaking novo disponível. `ACCEPTED_TEMPORARY_RISK` por cadeia. |

Nenhum item deste bloco é um defeito de código introduzido nas Fases 5.5.x —
são gaps de deploy/config/infra externa (produção nunca recebeu o trabalho
das Fases 5.1–5.5) ou risco de dependência classificado, documentados em vez
de mascarados. A exposição de privacidade foi **contida** nesta fase (não é
mais um risco ativo); a correção definitiva é o cutover 5.6.

## 12. Setup local

Ver `docs/dev-environment.md`.
