# Fase 5.6 — Log do cutover de produção

**Estado: PARCIAL — núcleo irreversível concluído e verificado; 3 passos
finais bloqueados pelo classificador de segurança do harness.**

Nenhum valor real (secret, token, id, connection string, senha) aparece
neste documento.

## Concluído e verificado (autônomo)

| # | Ação | Resultado |
|---|---|---|
| Preflight | `git` HEAD `c5d2a91`, 66 à frente de `origin/main` (era `0a64991`), working tree limpa. 42/42 testes, build limpo, `prisma validate` OK. | ✅ |
| Release source | `7639386..c5d2a91` = **docs-only** → `RELEASE_SOURCE_COMMIT = c5d2a91` (HEAD completo, auditado). | ✅ |
| Containment pré | `ssoProtection.deploymentType = "all"`; anon `/api/dashboard` → 302. | ✅ |
| Backup | `pre-cutover-2026-09-10` (`br-dark-sound-ac1j9voh`) existe, parent `production` @ LSN `0/34B1B08`, sem endpoint, `written_data_bytes: 0` no branch de produção (dado byte-idêntico ao snapshot). | ✅ |
| Decimal safety | Produção sem writes desde a auditoria 5.5.2 (`written_data_bytes: 0`) → auditoria 5.5.2 vale. `PRODUCTION_DECIMAL_MIGRATION_SAFE = YES`. | ✅ |
| Migration list | `prisma migrate status` (prod, read-only): exatamente as 7 esperadas, nenhuma desconhecida. | ✅ |
| **`prisma migrate deploy` (PRODUÇÃO)** | **As 7 migrations aplicadas com sucesso**, exit 0, na ordem. | ✅ |
| Schema verify | `migrate status` prod: "Database schema is up to date". `_prisma_migrations` = **12** = repo. Todas as tabelas V2 presentes (`LoginRateLimit`, `Reserve`, `TelegramUpdateReceipt`, `AppSettings`, …). 14/14 colunas monetárias agora `numeric`. Novas tabelas V2 nascidas vazias. | ✅ |
| Data sanity | Anchor de produção (row counts + sums de 12 tabelas monetárias) **byte-idêntico** antes / pós-migration / pós-deploy. `PRODUCTION_FINANCIAL_WRITES = ZERO`. | ✅ |
| **`git push origin main`** | Fast-forward `0a64991..c5d2a91`. `PRODUCTION_GIT_COMMIT = c5d2a91`. | ✅ |
| Vercel deploy | Auto-disparado pelo push. `dpl_DqqnGtUgzJAgJ5nmRbfeLLB2UzQE`, target production, commit `c5d2a91`, state **READY / PROMOTED**. Build: Prisma Client gerado, `✓ Compiled`, `ƒ Middleware 34.8 kB`, 34/34 páginas. Alias `financas-dashboard-omega.vercel.app` → novo deployment. Exatamente 1 release. | ✅ |
| **`INNER_APP_AUTH_READY`** | Verificado pelo Chrome do dono (sessão Vercel atravessa a proteção externa; **sem** sessão Norte): `GET /api/dashboard`, `/api/cash-flow`, `/api/goals`, `/api/cards` → **401 `{"error":"unauthorized"}`, zero payload financeiro**. `GET /` → redirect `/login`. `GET /login` → 200 (renderiza, tema escuro, sem leak). `POST /api/auth/login` senha errada → **401 `invalid_credentials`** (prova que `SESSION_SECRET` + `DASHBOARD_PASSWORD_HASH` estão presentes/válidos e o scrypt roda). | ✅ **YES** |
| Runtime logs | Sem erros / 500 / exceção Prisma no deployment. | ✅ |

## Bloqueado pelo classificador de segurança do harness — precisa do dono

O classificador de auto-mode bloqueia mudanças que **reduzem proteção de
segurança de produção** ou **escrevem material secreto em disco**, mesmo com
a autorização ampla desta fase. As 3 ações abaixo são exatamente isso.

### A. Transição da Deployment Protection (`all` → Standard)

Objetivo (passo 28-29): o domínio de produção passa a chegar ao app, que se
protege pela **própria auth do Norte** (já verificada acima). URLs de
deployment/preview continuam protegidas pela Vercel.

```bash
# via API (o dono roda, ou autoriza o agente):
curl -s -X PATCH "https://api.vercel.com/v9/projects/prj_lgNaQCUfyHPH1OGNdGGH9C1BrLB3?teamId=team_kucdLZ8ogqiP4qtMhNZwKTI2" \
  -H "Authorization: Bearer $(node -e "console.log(require(require('os').homedir()+'/Library/Application Support/com.vercel.cli/auth.json').token)")" \
  -H "Content-Type: application/json" \
  -d '{"ssoProtection":{"deploymentType":"prod_deployment_urls_and_all_previews"}}'
```
(ou: painel Vercel → Project → Settings → Deployment Protection → Vercel
Authentication → **Standard Protection**.)

**Imediatamente depois**, re-testar anônimo (sem sessão nenhuma):
`GET /api/dashboard` **deve** dar 401. Se der payload financeiro → reverter
`{"deploymentType":"all"}` na hora (P0).

### B. Login smoke real (passo 22-24)

O dono abre `https://financas-dashboard-omega.vercel.app/login` em aba
anônima, senha = a passphrase do keychain
(`security find-generic-password -s norte-dashboard-prod -w`), confirma que
cai na Home e que os números batem com o esperado.
(Prova matemática já existe: `verifyPassword(passphrase, hash) === true` foi
verificado na 5.5.3 com as funções reais do app, e esse hash exato está em
produção. O smoke confirma só a mecânica de cookie/sessão no runtime de
produção — idêntica à de dev, 18/18 em `test-security-integration.mjs`.)

### C. `setWebhook` do Telegram (passo 35)

Depois de (A), com o domínio chegando ao app:
```
setWebhook(url="https://financas-dashboard-omega.vercel.app/api/telegram/webhook",
           secret_token=<TELEGRAM_WEBHOOK_SECRET>)
```
Rodar de dentro de uma function deployada (recebe as env `sensitive` em
runtime) ou o dono roda com o token. Depois `getWebhookInfo` deve mostrar
`url` batendo e sem `last_error`. Uma mensagem controlada não-financeira do
dono autorizado fecha o smoke do Telegram.

## Rollback (se algo em A/B/C falhar)

- App: `vercel rollback` para `dpl_HLpsu2CR9GnRwSmtJ2pHV5Tv8yLx` (`0a64991`)
  — **CUIDADO**: o código pré-V2 espera `Float`, e as colunas agora são
  `numeric`. Prisma/pg lê `numeric` como string → o código antigo pode
  quebrar. Preferir **corrigir pra frente**.
- Dado: branch `pre-cutover-2026-09-10` (restore) ou PITR 6h. Só em
  corrupção real — as migrations foram aditivas + lossless, o anchor provou
  zero mudança.
- Exposição: reverter `ssoProtection` para `{"deploymentType":"all"}`.
