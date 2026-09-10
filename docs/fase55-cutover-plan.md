# Fase 5.5 — Plano de cutover para produção (PREPARADO, NÃO EXECUTADO)

Este documento é o plano exato de como ir de "código pré-produção pronto" pra
"em produção", pra ser executado na Fase 5.6 (ou por quem estiver com acesso
autenticado a Vercel/Neon/Telegram de produção). **Nada aqui foi executado.**
Nenhum valor real (token, secret, connection string) aparece neste documento.

## 0. Realidade da lacuna produção↔local (descoberta na Fase 5.5.1)

Inspeção read-only real (Neon `neonctl` + 1 GET no deployment):

- **Produção roda código PRÉ-V2, PRÉ-AUTENTICAÇÃO.** `origin/main` está 61
  commits atrás do local. `https://financas-dashboard-omega.vercel.app`:
  `/login` → 404, `/api/dashboard` → 200 **sem auth**, com payload
  financeiro real. Toda a camada de auth (5.3C+) e toda a arquitetura V2
  (5.1–5.5) nunca foram deployadas.
- **O branch `production` do Neon está 7 migrations atrás** (só as 5
  primeiras aplicadas). Pendentes, na ordem em que serão aplicadas:
  1. `20260904113909_convert_money_fields_to_decimal` — **TYPE CHANGE**
     (Float→Decimal(12,2), 17 colunas, `USING ROUND(x::numeric,2)`). A
     única não-trivial. O comentário da migration diz "Fase 3.0 confirmou
     que nenhum valor muda" — mas isso foi contra os dados de DEV. **Antes
     do cutover: re-rodar a auditoria da Fase 3.0 (docs/phase3-money-audit.md)
     contra os dados REAIS de produção** e confirmar que `ROUND(x,2)` não
     altera nenhuma linha.
  2. `20260904151538_appsettings_dataconfidence` — aditiva (ADD COLUMN
     nullable + CREATE TABLE). Segura.
  3. `20260904160000_domain_models_v2` — aditiva (9 tabelas novas vazias +
     CHECK constraints). Segura.
  4. `20260904180000_income_recurring_occurrence_date` — ADD COLUMN
     nullable + UNIQUE INDEX (NULLs distintos no Postgres → sem colisão em
     linhas existentes). Segura.
  5. `20260907204941_external_installment_due_timing` — roda contra tabelas
     criadas vazias em (3) → DROP NOT NULL + ADD COLUMN NOT NULL DEFAULT
     numa tabela vazia. Segura.
  6. `20260908175034_telegram_update_receipt` — CREATE TABLE. Segura.
  7. `20260909184113_login_rate_limit` — CREATE TABLE. Segura.

Conclusão: **6 das 7 são estritamente aditivas.** O cutover de banco é um
único `prisma migrate deploy` (aplica as 7 na ordem), precedido pela
auditoria de dados da migration (1). O cutover de código é o deploy do
bundle de 61 commits. É um cutover "big-bang" (produção vai de pré-V2 direto
pra V2 completo), então o smoke plan da seção 2 é obrigatório em cheio.

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

Por causa da lacuna da seção 0, a ordem importa:

1. `vercel login` + verificar env vars de produção (seção da matriz de blockers).
2. Confirmar backup: criar um branch-snapshot manual do `production` no Neon (a janela PITR de 6h é curta demais pra servir de rede sozinha).
3. **Re-rodar a auditoria de dados da Fase 3.0 contra os dados REAIS de produção** — confirmar que `convert_money_fields_to_decimal` (`ROUND(x::numeric,2)`) não altera nenhuma linha.
4. `prisma migrate status` contra produção (read-only) — reconfirmar as 7 pendentes.
5. `prisma migrate deploy` contra produção — aplica as 7 na ordem. **Nunca `db push`, nunca `migrate dev` contra produção.**
6. Verificar schema pós-migration (tabelas `LoginRateLimit`, `Reserve`, `TelegramUpdateReceipt` etc. presentes; colunas monetárias agora `numeric`).
7. **SÓ ENTÃO** promover/deployar o bundle de código (61 commits) — o código novo de login depende de `LoginRateLimit`, e o resto do V2 depende das outras 6 migrations.
8. Rodar o smoke plan (seção 2) inteiro.

A `LoginRateLimit` migration DEVE preceder o deploy do código de login: sem
a tabela, `isBlocked`/`recordFailure` lançam → o handler FAIL_CLOSED
devolveria 429 pra TODA tentativa de login (trava o dono pra fora). É
seguro-por-design, mas indisponível.

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
10. Telegram: `getWebhookInfo` (read-only, com o token real de produção) — confirma que a URL do webhook registrada bate com o domínio de produção real, e que não há `last_error_message` recente.
11. Telegram: mandar `/start` (ou equivalente) de uma conta QUE NÃO é `TELEGRAM_ALLOWED_USER_ID` — confirma que o bot não processa/responde (allowlist viva em produção).
12. Verificar nos Vercel Runtime Logs que nenhuma das chamadas acima produziu um 500 inesperado.
13. **[RESERVADO PRA FASE 5.6]** Escrita controlada: 1 lançamento sintético mínimo (ex: uma `Expense` de R$0,01 com descrição claramente marcada como teste), confirmar que aparece corretamente no dashboard, depois apagar e confirmar fingerprint volta ao estado anterior.
14. **[RESERVADO PRA FASE 5.6]** Mensagem Telegram controlada: 1 mensagem de teste enviada pelo dono real (`TELEGRAM_ALLOWED_USER_ID`) pro bot em produção, confirmando que o webhook processa de ponta a ponta.

## 3. CUTOVER_ROLLBACK_PLAN (preparado — execução só se necessário)

| Camada | Como reverter | Limitações conhecidas |
|---|---|---|
| Aplicação (código) | Vercel → Deployments → escolher o deployment anterior → "Promote to Production" (ou `vercel rollback` via CLI autenticado) | Reversão de aplicação é rápida e sem downtime — mas não desfaz migração de banco nem reverte webhook (ver linhas abaixo) |
| Migração de banco (7 migrations) | 6 das 7 são ADITIVAS (CREATE TABLE / ADD COLUMN nullable) — reverter o CÓDIGO é suficiente; as tabelas/colunas novas ficam órfãs e inofensivas pra uma versão anterior. A exceção é `convert_money_fields_to_decimal` (Float→Decimal): reverter Decimal→Float é possível (`ALTER COLUMN ... TYPE double precision`) e não perde precisão (Decimal→double é lossless pra valores de 2 casas), mas é uma migration manual reversa que precisa ser escrita e testada — não é `prisma migrate down` automático | Prisma não tem `migrate down`. Se a de Decimal precisar reverter: script SQL manual explícito, e só se o código revertido realmente exigir Float de volta (o código pré-V2 espera Float). Preferível: não reverter — corrigir pra frente |
| Neon (dado) | Branch-snapshot manual criado no passo 2 da ordem de cutover → restaurar a partir dele. PITR de 6h (`history_retention_seconds=21600`, verificado na Fase 5.5.1) como rede secundária, só dentro da janela | Restore é DESTRUTIVO e amplo (afeta TODOS os dados). Só cabível em corrupção real de dado, nunca pra um bug de aplicação isolado. O branch `production` não está `protected` — o snapshot manual é a salvaguarda real |
| Telegram (webhook) | `setWebhook` apontando de volta pra URL/secret anteriores (só o dono, com o token real, pode executar) | Esta sessão nunca tem token de bot disponível — não pode nem verificar nem reverter; é sempre uma ação humana direta |
| Variáveis de ambiente (Vercel) | Reverter manualmente pro valor anterior em Project Settings → Environment Variables, seguido de um redeploy | Como nenhum valor real é registrado em lugar nenhum (nem aqui, nem em `.env.example`), reverter um env var exige que o dono tenha o valor anterior guardado em algum cofre de senhas próprio — fora do escopo deste projeto/sessão |

## 4. RELEASE_CANDIDATE_COMMIT

O commit que fecha a Fase 5.5.1 é o `RELEASE_CANDIDATE` desta rodada —
build limpo (`next@15.5.25`), 42/42 arquivos de teste passando (41
pré-existentes + `test-security-ratelimit.mjs` novo, com 37 checagens),
fingerprint financeiro
idêntico ao baseline (`PRE_551 == POST_551`), leak scan limpo, bundle sem
vazamento de segredo pro client, 2 RCE críticas do Next.js resolvidas.
Nenhum commit posterior a este é implicitamente "candidato" até uma nova
rodada de validação equivalente. **É candidato de CÓDIGO — não de deploy:
o cutover ainda depende de tudo na seção 0 e na matriz de blockers.**

## 5. PREPRODUCTION_BLOCKER_MATRIX

Ver seção 11 (`Blockers conhecidos de pré-produção`) de
`docs/final-architecture.md` — matriz autoritativa e única. Resumo ao fim
da Fase 5.5.1, por classificação:

- **RESOLVIDO (código)**: rate limit client-resettable → server-authoritative
  + bounded + fail-closed + missing-IP-fail-closed. 2 RCE críticas do
  Next.js → `next@15.5.25`.
- **CODE_DEPLOYMENT (crítico)**: produção roda código pré-autenticação —
  API financeira pública. Corrigido só pelo cutover.
- **PENDING_PRODUCTION_MIGRATION**: 7 migrations pendentes em produção (6
  aditivas, 1 type-change com auditoria de dados prévia).
- **`BLOCKED_BY_EXTERNAL_ACCESS`**: env vars de produção (Vercel — `vercel
  whoami` deslogado), domínio/projeto (Vercel), token/webhook do Telegram.
- **PARCIALMENTE VERIFICADO (Neon, read-only)**: fronteira dev/prod OK;
  PITR 6h; branch de produção não-`protected`.
- **`ACCEPTED_DEPENDENCY_RISK`**: cadeia `request`/`node-telegram-bot-api`
  (não-alcançável pelo runtime; fix = upgrade major, fase própria);
  build-time (`postcss`/`nanoid`) e devDependency (`prisma`/`deepmerge-ts`).
- **`PRODUCT_DEFERRED`**: leitura dedicada de 30/60/90 no Telegram.
