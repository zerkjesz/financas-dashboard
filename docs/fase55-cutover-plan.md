# Fase 5.5 — Plano de cutover para produção (PREPARADO, NÃO EXECUTADO)

Este documento é o plano exato de como ir de "código pré-produção pronto" pra
"em produção", pra ser executado na Fase 5.6 (ou por quem estiver com acesso
autenticado a Vercel/Neon/Telegram de produção). **Nada aqui foi executado.**
Nenhum valor real (token, secret, connection string) aparece neste documento.

## 1. CUTOVER_OBSERVABILITY_MAP

O que observar nas primeiras horas/dias após o deploy, e onde:

| Sinal | Onde observar | O que indicaria problema |
|---|---|---|
| Taxa de erro 5xx em `/api/**` | Vercel → Project → Logs (Runtime Logs), filtro por status | Qualquer 5xx sustentado (não isolado) em rota que não seja `auth_not_configured` esperado por env faltando |
| Taxa de 401/403 em rotas autenticadas | Vercel Runtime Logs | Pico anômalo pode indicar cookie/secret mal configurado após deploy (ex: `SESSION_SECRET` diferente do anterior invalidando sessões — esperado 1x no primeiro deploy, não recorrente) |
| Taxa de 429 em `/api/auth/login` | Vercel Runtime Logs, filtro `/api/auth/login` | 429 esporádico é o rate limiter funcionando; 429 sustentado pro dono real logando seria falso-positivo — checar `LoginRateLimit` no Postgres pelo `key` (nunca pelo IP em texto puro — a tabela só guarda o hash) |
| Latência de `/api/auth/login` | Vercel Runtime Logs (duration) | Fase 5.5 adicionou 1-2 queries Postgres ao caminho de login (`isBlocked`/`recordFailure`/`clearAttempts`) — esperar um pequeno aumento de latência (ordem de dezenas de ms), não segundos |
| Crescimento da tabela `LoginRateLimit` | Query read-only no Neon (`SELECT count(*) FROM "LoginRateLimit"`) | Linhas antigas (`updatedAt` > 1h, sem `blockedUntil` futuro) deveriam ser naturalmente irrelevantes (a janela de 1h já as neutraliza), mas não há job de limpeza automática nesta fase — crescimento não-bounded ao longo de meses é um item pra observar, não urgente (cada linha é ~100 bytes, milhares de IPs únicos tentando login ainda seriam poucos MB) |
| Conexões Postgres simultâneas (Neon) | Neon Console → Monitoring | O rate limiter adiciona 1-2 queries por tentativa de login — volume normal de uso pessoal (1 usuário) não deveria aproximar limites de conexão do plano Neon |
| Webhook do Telegram: updates recebidos vs. processados | Logs da rota `/api/telegram/webhook` (Vercel Runtime Logs) | Updates rejeitados com 401 (secret errado) de forma sustentada indicaria `TELEGRAM_WEBHOOK_SECRET` divergente entre o `setWebhook` real e o env var configurado |
| Fingerprint financeiro | `/api/dashboard` autenticado, comparar contra o baseline conhecido | Qualquer divergência não-explicada por uma transação real do usuário é um alerta imediato |

## 2. POST_DEPLOY_SMOKE_PLAN (preparado — execução só na Fase 5.6)

Ordem exata de verificação manual pós-deploy, do menos ao mais arriscado.
**Os 2 últimos passos (escrita controlada e mensagem Telegram controlada)
ficam explicitamente reservados pra Fase 5.6 — não executar como parte da
5.5**, mesmo que o resto deste plano seja seguido antes disso.

1. `GET /` (Home) sem cookie — confirma que o middleware redireciona pra `/login` (deny-by-default).
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
| Migração de banco (`LoginRateLimit`) | Esta migração é estritamente ADITIVA (só `CREATE TABLE`, nenhuma coluna/tabela existente alterada) — reverter o CÓDIGO da aplicação (linha acima) é suficiente; a tabela nova fica órfã e inofensiva (não é lida por nenhum código de uma versão anterior) até uma decisão futura de removê-la | Reverter a MIGRAÇÃO em si (`prisma migrate` down) não é uma operação nativa do Prisma — se algum dia for necessário remover a tabela, é um `DROP TABLE "LoginRateLimit"` manual, explícito, só depois de confirmar que nenhuma versão em produção ainda a usa |
| Neon (dado) | Point-in-time restore, SE confirmado disponível no plano/branch (ver blocker `BLOCKED_BY_EXTERNAL_ACCESS` na seção 11 de `docs/final-architecture.md` — não verificado nesta sessão) | Um restore de banco é uma operação DESTRUTIVA e ampla (afeta TODOS os dados, não só o que quebrou) — só cabível em um cenário de corrupção real de dado, nunca como resposta a um bug de aplicação isolado |
| Telegram (webhook) | `setWebhook` apontando de volta pra URL/secret anteriores (só o dono, com o token real, pode executar) | Esta sessão nunca tem token de bot disponível — não pode nem verificar nem reverter; é sempre uma ação humana direta |
| Variáveis de ambiente (Vercel) | Reverter manualmente pro valor anterior em Project Settings → Environment Variables, seguido de um redeploy | Como nenhum valor real é registrado em lugar nenhum (nem aqui, nem em `.env.example`), reverter um env var exige que o dono tenha o valor anterior guardado em algum cofre de senhas próprio — fora do escopo deste projeto/sessão |

## 4. RELEASE_CANDIDATE_COMMIT

O commit que fecha a Fase 5.5 (a ser feito logo após este documento) é o
`RELEASE_CANDIDATE` desta rodada de pré-produção — build limpo, 42/42 testes
passando (41 pré-existentes + `test-security-ratelimit.mjs` novo),
fingerprint financeiro idêntico ao baseline, leak scan limpo, bundle sem
vazamento de segredo pro client. Nenhum commit posterior a este é
implicitamente "candidato" até uma nova rodada de validação equivalente.

## 5. PREPRODUCTION_BLOCKER_MATRIX

Ver seção 11 (`Blockers conhecidos de pré-produção`) de
`docs/final-architecture.md` — é a matriz autoritativa e única (evita duas
cópias divergentes do mesmo dado). Resumo do estado ao fim da Fase 5.5:

- **RESOLVIDO nesta fase**: rate limit client-resettable.
- **`BLOCKED_BY_EXTERNAL_ACCESS`** (exigem ação humana com credencial que esta
  sessão nunca teve): env vars de produção (Vercel), `DIRECT_URL` em
  produção, backup/PITR (Neon), domínio/HTTPS (Vercel), token/webhook do
  Telegram em produção.
- **`ACCEPTED_TEMPORARY_RISK`**: 3 das 16 vulnerabilidades do `npm audit`
  (cadeia `uuid`/`@cypress/request`/`node-telegram-bot-api`, só corrigível
  via upgrade major 0.66→2.x do `node-telegram-bot-api` — migração é fase
  própria, fora do escopo de infraestrutura da 5.5).
- **`PRODUCT_DEFERRED`**: leitura dedicada de 30/60/90 no Telegram (não
  bloqueia produção).
