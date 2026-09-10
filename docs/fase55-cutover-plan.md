# Fase 5.5 — Plano de cutover para produção (PREPARADO, NÃO EXECUTADO)

Este documento é o plano exato de como ir de "código pré-produção pronto" pra
"em produção", pra ser executado na Fase 5.6 (ou por quem estiver com acesso
autenticado a Vercel/Neon/Telegram de produção). **Nada aqui foi executado.**
Nenhum valor real (token, secret, connection string) aparece neste documento.

## 0. Realidade da lacuna produção↔local (5.5.1) + o que já foi feito (5.5.2)

### Lacuna

- **Produção roda código PRÉ-V2, PRÉ-AUTENTICAÇÃO.** `origin/main` está 61
  commits atrás do local. Toda a auth (5.3C+) e a arquitetura V2 (5.1–5.5)
  nunca foram deployadas.
- **O branch `production` do Neon está 7 migrations atrás** (5 aplicadas).

### Já executado na Fase 5.5.2 (ações protetivas — NÃO cutover)

- **Contenção da exposição de privacidade**: Vercel Deployment Protection
  `ssoProtection.deploymentType = "all"`. `/` e `/api/dashboard` anônimos
  agora → 302 SSO; `/api/telegram/webhook` anônimo → 401. Ver
  `docs/fase552-production-containment.md`. **Efeito colateral aceito**: bot
  Telegram offline até o cutover.
- **Backup pré-cutover**: branch Neon `pre-cutover-2026-09-10`
  (`br-dark-sound-ac1j9voh`), sem endpoint, CoW, do `production` @ LSN
  `0/34B1B08`. Não modifica dados do parent.
- **Auditoria de dados da migration de Decimal contra PRODUÇÃO** (read-only):
  0 NaN/Inf, 0 overflow `DECIMAL(12,2)`, **0 linhas alteradas por ROUND**
  (maxΔ=0.00). `PRODUCTION_DECIMAL_MIGRATION_SAFE = YES`.
- **Inventário de env de produção** (`vercel env ls production`): só
  `DATABASE_URL` + `TELEGRAM_TOKEN` presentes. Faltam `DIRECT_URL`,
  `DATABASE_ENV`, `SESSION_SECRET`, `DASHBOARD_PASSWORD_HASH`,
  `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_ID`, `APP_TIMEZONE`.
  `AUTH_DEV_BYPASS` ausente (seguro).

### `PENDING_MIGRATION_RISK_MATRIX` (as 7, na ordem de aplicação)

| # | Migration | Classe | Verdito |
|---|---|---|---|
| 1 | `convert_money_fields_to_decimal` | DATA_TRANSFORMING (Float→Decimal, 17 col) | **SAFE** — auditado vs dados de produção, 0 impacto |
| 2 | `appsettings_dataconfidence` | ADDITIVE (`ADD COLUMN` nullable ×7 + `CREATE TABLE`) | SAFE |
| 3 | `domain_models_v2` | ADDITIVE (7 enums + 9 tabelas vazias + CHECK) | SAFE |
| 4 | `income_recurring_occurrence_date` | ADDITIVE (`ADD COLUMN` DATE nullable + UNIQUE INDEX; NULLs distintos → sem colisão nas 13 linhas) | SAFE |
| 5 | `external_installment_due_timing` | ADDITIVE + `DROP NOT NULL` ×2 (tabela criada vazia em #3) | SAFE |
| 6 | `telegram_update_receipt` | ADDITIVE (`CREATE TABLE` + índices) | SAFE |
| 7 | `login_rate_limit` | ADDITIVE (`CREATE TABLE`) | SAFE |

Nenhuma migration pendente tem `UPDATE`/`DELETE`/`INSERT` de dados, `DROP
TABLE`/`DROP COLUMN`. Cutover de banco = um `prisma migrate deploy` (aplica
as 7 na ordem). Cutover de código = deploy do bundle de 61 commits.
"Big-bang" (produção vai de pré-V2 direto pra V2 completo) → smoke plan
(seção 2) obrigatório em cheio.

## 1. CUTOVER_OBSERVABILITY_MAP

O que observar nas primeiras horas/dias após o deploy, e onde:

| Sinal | Onde observar | O que indicaria problema |
|---|---|---|
| Taxa de erro 5xx em `/api/**` | Vercel → Project → Logs (Runtime Logs), filtro por status | Qualquer 5xx sustentado (não isolado) em rota que não seja `auth_not_configured` esperado por env faltando |
| Taxa de 401/403 em rotas autenticadas | Vercel Runtime Logs | Pico anômalo pode indicar cookie/secret mal configurado após deploy (ex: `SESSION_SECRET` diferente do anterior invalidando sessões — esperado 1x no primeiro deploy, não recorrente) |
| Taxa de 429 em `/api/auth/login` | Vercel Runtime Logs, filtro `/api/auth/login` | 429 esporádico é o rate limiter funcionando; 429 sustentado pro dono real logando seria falso-positivo — checar `LoginRateLimit` no Postgres pelo `key` (nunca pelo IP em texto puro — a tabela só guarda o hash) |
| Latência de `/api/auth/login` | Vercel Runtime Logs (duration) | Fase 5.5 adicionou 1-2 queries Postgres ao caminho de login (`isBlocked`/`recordFailure`/`clearAttempts`) — esperar um pequeno aumento de latência (ordem de dezenas de ms), não segundos |
| Crescimento da tabela `LoginRateLimit` | Query read-only no Neon (`SELECT count(*) FROM "LoginRateLimit"`) | Fase 5.5.1 adicionou `sweepExpired()` — limpeza física oportunista, atômica e bounded (LIMIT 100) a cada `recordFailure`. Sob uso pessoal a tabela deve ficar perto de zero. Um crescimento sustentado de milhares de linhas indicaria ataque distribuído em curso (rows de IPs distintos acumulando mais rápido que o sweep drena) — observar, não é falha do mecanismo |
| Conexões Postgres simultâneas (Neon) | Neon Console → Monitoring | O rate limiter adiciona 1-2 queries por tentativa de login — volume normal de uso pessoal (1 usuário) não deveria aproximar limites de conexão do plano Neon |
| Webhook do Telegram: updates recebidos vs. processados | Logs da rota `/api/telegram/webhook` (Vercel Runtime Logs) | Updates rejeitados com 401 (secret errado) de forma sustentada indicaria `TELEGRAM_WEBHOOK_SECRET` divergente entre o `setWebhook` real e o env var configurado |
| Fingerprint financeiro | `/api/dashboard` autenticado, comparar contra o baseline conhecido | Qualquer divergência não-explicada por uma transação real do usuário é um alerta imediato |

## 1b. ORDEM DE CUTOVER (obrigatória — não executar agora)

Passos já concluídos na Fase 5.5.2 (ver seção 0): contenção da exposição,
backup `pre-cutover-2026-09-10`, auditoria de dados da migration de Decimal,
inventário de env.

Resta pro cutover (5.6):

1. **Env vars de produção**:
   - **JÁ SETADAS na 5.5.2** (`vercel env add`): `DIRECT_URL` (endpoint
     `production` do Neon, unpooled), `DATABASE_ENV=production`,
     `APP_TIMEZONE=America/Sao_Paulo`. `DATABASE_URL`/`TELEGRAM_TOKEN` já
     existiam.
   - **AINDA FALTAM — `HUMAN_ACTION_REQUIRED`** (segredos, não inventáveis):
     `SESSION_SECRET` (gerar: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`),
     `DASHBOARD_PASSWORD_HASH` (`node scripts/generate-password-hash.mjs "<senha>"`),
     `TELEGRAM_WEBHOOK_SECRET` (string aleatória longa),
     `TELEGRAM_ALLOWED_USER_ID` (o `from.id` do dono no Telegram).
   - Confirmar `AUTH_DEV_BYPASS` continua **ausente**.
2. `prisma migrate status` contra produção (read-only) — reconfirmar as 7 pendentes.
3. `prisma migrate deploy` contra produção — aplica as 7 na ordem (precisa de
   `DIRECT_URL` do passo 1). **Nunca `db push`, nunca `migrate dev` contra produção.**
4. Verificar schema pós-migration (`LoginRateLimit`, `Reserve`,
   `TelegramUpdateReceipt`, `AppSettings` presentes; colunas monetárias agora
   `numeric`).
5. **SÓ ENTÃO** promover/deployar o bundle de código (61 commits).
6. Rodar o smoke plan (seção 2) inteiro.
7. **Telegram**: com a auth já deployada, configurar um **Protection Bypass**
   da Vercel só pro path `/api/telegram/webhook` (ou reavaliar a Deployment
   Protection). NÃO `setWebhook` — a config do webhook no lado do Telegram
   nunca foi tocada, só bloqueada na borda.

A `LoginRateLimit` migration DEVE preceder o deploy do código de login: sem
a tabela, `isBlocked`/`recordFailure` lançam → o handler FAIL_CLOSED
devolveria 429 pra TODA tentativa de login (trava o dono pra fora). É
seguro-por-design, mas indisponível.

`prisma migrate deploy` funciona num branch Neon **não-`protected`** (o plano
gratuito não permite protected branches) — a proteção real é o snapshot
`pre-cutover-2026-09-10` + a janela PITR de 6h.

## 2. POST_DEPLOY_SMOKE_PLAN (preparado — execução só na Fase 5.6)

Ordem exata de verificação manual pós-deploy, do menos ao mais arriscado.
**Os 2 últimos passos (escrita controlada e mensagem Telegram controlada)
ficam explicitamente reservados pra Fase 5.6 — não executar como parte da
5.5**, mesmo que o resto deste plano seja seguido antes disso.

1. `GET /` (Home) sem cookie — confirma que o middleware redireciona pra `/login` (deny-by-default). **Antes do cutover isto retorna 200 com o dashboard público — é o bug que o cutover corrige.**
2. `GET /login` — confirma que a página carrega (build/CSS/JS servidos corretamente).
3. Tentar login com senha ERRADA (proposital) — confirma 401, confirma que a resposta não vaza detalhe interno.
4. Tentar login com senha CORRETA — confirma 200 + cookie de sessão HttpOnly/SameSite=Lax setado.
5. `GET /` autenticado — confirma que o dashboard carrega e os números batem com o que o usuário espera ver (comparação visual, não automatizada).
6. `GET /api/dashboard` autenticado — confirma payload JSON válido, `financial.liquidity` presente.
7. Testar 1 rota de mutação com Origin cross-site de propósito (ex: via `curl` com `Origin: https://attacker.example`) — confirma 403 (CSRF guard vivo em produção).
8. Provocar 6 tentativas de login erradas seguidas — confirma que a 7ª retorna 429 (rate limiter vivo em produção, não só em dev).
9. Logout — confirma que a rota responde e que uma tentativa seguinte a `/api/dashboard` com o cookie antigo falha (sessão invalidada).
10. Telegram: `getWebhookInfo` (read-only, com o token real de produção) — confirma que a URL do webhook registrada bate com o domínio de produção real. Esperado após a contenção da 5.5.2: `pending_update_count` alto e `last_error_message` tipo "Wrong response from the webhook: 401" — some depois do Protection Bypass do passo 7 da ordem de cutover.
11. Telegram: mandar `/start` (ou equivalente) de uma conta QUE NÃO é `TELEGRAM_ALLOWED_USER_ID` — confirma que o bot não processa/responde (allowlist viva em produção).
12. Verificar nos Vercel Runtime Logs que nenhuma das chamadas acima produziu um 500 inesperado.
13. **[RESERVADO PRA FASE 5.6]** Escrita controlada: 1 lançamento sintético mínimo (ex: uma `Expense` de R$0,01 com descrição claramente marcada como teste), confirmar que aparece corretamente no dashboard, depois apagar e confirmar fingerprint volta ao estado anterior.
14. **[RESERVADO PRA FASE 5.6]** Mensagem Telegram controlada: 1 mensagem de teste enviada pelo dono real (`TELEGRAM_ALLOWED_USER_ID`) pro bot em produção, confirmando que o webhook processa de ponta a ponta.

## 3. CUTOVER_ROLLBACK_PLAN (preparado — execução só se necessário)

| Camada | Como reverter | Limitações conhecidas |
|---|---|---|
| Aplicação (código) | Vercel → Deployments → escolher o deployment anterior → "Promote to Production" (ou `vercel rollback` via CLI autenticado) | Reversão de aplicação é rápida e sem downtime — mas não desfaz migração de banco nem reverte webhook (ver linhas abaixo) |
| Migração de banco (7 migrations) | 6 das 7 são ADITIVAS (CREATE TABLE / ADD COLUMN nullable) — reverter o CÓDIGO é suficiente; as tabelas/colunas novas ficam órfãs e inofensivas pra uma versão anterior. A exceção é `convert_money_fields_to_decimal` (Float→Decimal): reverter Decimal→Float é possível (`ALTER COLUMN ... TYPE double precision`) e não perde precisão (Decimal→double é lossless pra valores de 2 casas), mas é uma migration manual reversa que precisa ser escrita e testada — não é `prisma migrate down` automático | Prisma não tem `migrate down`. Se a de Decimal precisar reverter: script SQL manual explícito, e só se o código revertido realmente exigir Float de volta (o código pré-V2 espera Float). Preferível: não reverter — corrigir pra frente |
| Neon (dado) | Snapshot **`pre-cutover-2026-09-10`** (`br-dark-sound-ac1j9voh`) já criado na 5.5.2 → restaurar a partir dele (`neonctl branches restore` ou promover). PITR de 6h como rede secundária, só dentro da janela | Restore é DESTRUTIVO e amplo (afeta TODOS os dados). Só cabível em corrupção real de dado, nunca pra um bug de aplicação isolado. `production` não é `protected` (plano gratuito) — o snapshot é a salvaguarda real |
| Telegram (webhook) | Nada a reverter — a config do webhook no lado do Telegram nunca foi tocada nesta fase (só bloqueada na borda da Vercel). Reverter = remover o Protection Bypass do path do webhook | Só o dono, com o token real, pode rodar `getWebhookInfo` pra confirmar o estado |
| Variáveis de ambiente (Vercel) | Reverter manualmente pro valor anterior em Project Settings → Environment Variables, seguido de um redeploy | Como nenhum valor real é registrado em lugar nenhum (nem aqui, nem em `.env.example`), reverter um env var exige que o dono tenha o valor anterior guardado em algum cofre de senhas próprio — fora do escopo deste projeto/sessão |

## 4. RELEASE_CANDIDATE_COMMIT

O commit que fecha a Fase 5.5.2 é o `RELEASE_CANDIDATE_CODE_COMMIT` desta
rodada — build limpo (`next@15.5.25`), regressão completa verde,
fingerprint financeiro idêntico ao baseline (`PRE_552 == POST_552`), leak
scan limpo, 2 RCE críticas do Next.js resolvidas, storage do rate limiter
reclassificado honestamente + EXPLAIN real. Nenhum commit posterior é
implicitamente "candidato" até uma nova rodada de validação equivalente.
**É candidato de CÓDIGO — não de deploy: o cutover ainda depende dos env
secrets humanos + migrations, na seção 1b.**

## 5. PREPRODUCTION_BLOCKER_MATRIX

Ver seção 11 (`Blockers conhecidos de pré-produção`) de
`docs/final-architecture.md` — matriz autoritativa e única. Resumo ao fim
da Fase 5.5.2, por classificação:

- **RESOLVIDO (código)**: rate limit client-resettable → server-authoritative
  + fail-closed + missing-IP-fail-closed + GC eventual bounded. 2 RCE
  críticas do Next.js → `next@15.5.25`.
- **CONTIDO (5.5.2)**: exposição anônima da API financeira → Vercel
  Deployment Protection "all". Fix definitivo = cutover.
- **PENDING_CUTOVER_MIGRATION**: 7 migrations pendentes (6 aditivas; a de
  Decimal **auditada segura contra dados de produção**).
- **VERIFICADO (5.5.2, Vercel + Neon autenticados)**: env de produção
  inventariada (só `DATABASE_URL`+`TELEGRAM_TOKEN`; `AUTH_DEV_BYPASS`
  ausente = seguro); domínio/projeto/HTTPS OK; fronteira dev/prod OK; PITR
  6h; backup snapshot criado.
- **`HUMAN_ACTION_REQUIRED`**: 4 env secrets de produção (`SESSION_SECRET`,
  `DASHBOARD_PASSWORD_HASH`, `TELEGRAM_WEBHOOK_SECRET`,
  `TELEGRAM_ALLOWED_USER_ID`); `getWebhookInfo` (token é `sensitive`,
  ilegível).
- **NOT_AVAILABLE_ON_PLAN**: Neon branch protection (plano gratuito = 0
  protected branches) — mitigado pelo snapshot manual.
- **`ACCEPTED_DEPENDENCY_RISK`**: cadeia `request`/`node-telegram-bot-api`
  (não-alcançável pelo runtime; fix = upgrade major, fase própria);
  build-time (`postcss`/`nanoid`) e devDependency (`prisma`/`deepmerge-ts`).
- **`PRODUCT_DEFERRED`**: leitura dedicada de 30/60/90 no Telegram.
