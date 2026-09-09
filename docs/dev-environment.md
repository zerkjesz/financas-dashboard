# Ambiente de desenvolvimento/teste — Norte v2, Fase 2A

## Objetivo

Hoje `.env` local aponta pro MESMO banco Postgres que produção (Vercel) usa —
não existe separação nenhuma. Qualquer script rodado localmente escreve direto em
produção. Isso muda aqui.

## Estratégia: branch de banco no Neon

O Neon (onde o Postgres deste projeto já mora) tem branching nativo: um branch novo é
uma cópia instantânea (copy-on-write) do banco em um ponto no tempo, com sua própria
connection string, sem duplicar armazenamento nem exigir dump/restore manual. É
exatamente o mecanismo certo aqui — mais simples que manter um segundo projeto Neon
do zero, e mais seguro que compartilhar o banco de produção.

```
Neon project "financas-dashboard"
├── branch "main"  (produção — Vercel aponta pra cá, e só pra cá)
└── branch "dev"   (novo — local e scripts de teste apontam pra cá)
```

## 1. Como organizar as env vars

- **`.env`** (local, gitignorado) → `DATABASE_URL` do branch **`dev`**. É o que
  `npm run dev`, `npm run bot` e qualquer script rodado à mão na sua máquina usam por
  padrão a partir de agora.
- **Vercel → Project Settings → Environment Variables → Production** → `DATABASE_URL`
  do branch **`main`**. Não muda nada — já está assim.
- **Nenhum arquivo `.env.production` local.** Produção nunca deveria existir como
  arquivo em disco na sua máquina. Se um dia for genuinamente necessário rodar algo
  pontual contra produção (não um script de teste — algo deliberado, tipo o script de
  migração legada que já existe), a connection string de produção é colada na hora, na
  variável de ambiente do comando, e descartada depois — nunca salva num arquivo.
- **`.env.example`** já atualizado — reflete que o valor padrão esperado é o branch
  de dev/test, não produção.

Isso resolve os objetivos "produção nunca receber escrita de testes" e "DATABASE_URL
de produção continuar separado" — a separação é física (branches diferentes do Neon),
não só uma convenção de nome de variável.

## 2. Qual DATABASE_URL cada ambiente usa

| Ambiente | Onde roda | DATABASE_URL |
|---|---|---|
| `npm run dev` (local) | sua máquina | branch `dev` (via `.env`) |
| `npm run bot` (local) | sua máquina | branch `dev` (via `.env`) |
| Scripts (`audit.js`, testes de integração futuros) | sua máquina | branch `dev` (via `.env`) |
| Produção (site + bot webhook) | Vercel | branch `main` (env var da Vercel, Production) |
| Preview deploys da Vercel (se algum dia existirem) | Vercel | recomendado: branch `dev` também (env var da Vercel, Preview) — opcional, você não usa preview deploys hoje |

## 3. Como impedir um script de teste de rodar acidentalmente contra produção

Novo módulo: [`scripts/lib/assertTestEnvironment.js`](../scripts/lib/assertTestEnvironment.js).

Qualquer script que **escreve** dados de teste deve chamar `assertTestEnvironment()`
como a primeira coisa que faz.

**Princípio: fail closed.** Não é "bloqueia se parecer produção" — é "só libera se
as 3 condições abaixo provarem, juntas, que é seguro". Configuração ausente (ex:
`DATABASE_ENV` não setada) é tratada como risco — o script não roda por padrão, tem
que ser explicitamente autorizado. Ele aborta (`process.exit(1)`) a menos que **todas**
estas 3 condições sejam verdadeiras:

1. `VERCEL_ENV !== "production"` (a Vercel seta isso sozinha em todo build/runtime de
   produção — zero configuração necessária).
2. `DATABASE_ENV` é **exatamente** `"development"` ou `"test"` — variável nova, você
   precisa setar isso à mão no seu `.env` local (já está no `.env.example`). Qualquer
   outro valor — incluindo a variável simplesmente não existir — bloqueia. É essa
   condição que torna a proteção fail-closed: sem ela setada de propósito, nada roda.
3. `DATABASE_URL` não contém o host de produção conhecido deste projeto
   (`ep-odd-lab-ac5srwxf-pooler`) — camada independente da condição 2, pro caso de
   `DATABASE_ENV` estar mal configurada (ex: alguém copiou o `.env` errado).

Não existe flag pra pular essa checagem de propósito. Um script que precisa mesmo
escrever em produção deliberadamente (não é o caso de nenhum script de teste) não deve
importar esse módulo — ele é estritamente pra código que **nunca**, em circunstância
nenhuma, deveria tocar produção.

Uso (em qualquer script novo de teste/integração):
```js
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment(); // primeira linha, antes de qualquer import do Prisma se der
```

`scripts/audit.js` e `scripts/migrate-legacy-transactions.js` **não** foram alterados
pra usar esse guard: o primeiro é só leitura (sem risco de escrita em lugar nenhum); o
segundo é deliberadamente uma migração de dado que roda contra o banco real — colocar
esse guard nele o impediria de fazer o que existe pra fazer.

## 4. Como aplicar migrations primeiro no ambiente de dev/test

```bash
# com .env apontando pro branch "dev"
npm run db:migrate:dev
```

Isso roda `prisma migrate dev` — cria o arquivo de migration (se houver mudança de
schema pendente), aplica no branch `dev`, e regenera o client. É seguro rodar quantas
vezes precisar, é o ambiente pra isso.

## 5. Como executar scripts de integração nesse ambiente

Com `.env` apontando pro branch `dev`:
```bash
node scripts/audit.js                 # já funciona hoje, só leitura
node scripts/qualquer-teste-novo.mjs  # futuro — chama assertTestEnvironment() primeiro
```
Nenhum comando especial necessário além de garantir que `.env` está no branch certo —
é por isso que a checagem do item 3 existe: não depender de "lembrar" de checar isso
toda vez.

## 6. Como promover migrations aprovadas para produção

Depois de validar no branch `dev` (item 4) e testar a aplicação contra ele:

```bash
# com DATABASE_URL apontando pro branch "main" (produção) só por esse comando —
# ex: DATABASE_URL="<connection string de produção>" npm run db:migrate:deploy
npm run db:migrate:deploy
```

`prisma migrate deploy` (diferente de `migrate dev`) é o comando feito pra produção:
não é interativo, não tenta gerar uma migration nova nem perguntar nada — só aplica,
em ordem, as migrations que já existem no repositório e ainda não foram aplicadas
naquele banco. É o mesmo arquivo de migration testado no branch `dev` no item 4, só
apontado pro banco certo.

Fluxo completo de uma mudança de schema, do início ao fim:
1. Editar `prisma/schema.prisma`.
2. `npm run db:migrate:dev` (contra o branch `dev`) — gera e aplica a migration ali.
3. Testar a aplicação/scripts contra o branch `dev`.
4. Revisar o arquivo de migration gerado em `prisma/migrations/`.
5. Só então, deliberadamente, `npm run db:migrate:deploy` contra produção.
6. `git push` (o schema + a migration já commitados) — o deploy da Vercel só roda
   `prisma generate` (via `postinstall`), não `migrate deploy` — então o passo 5 tem
   que acontecer manualmente, antes ou depois do push, nunca fica implícito num
   deploy automático.

## O que você precisa fazer manualmente (Neon)

Não tenho `neonctl` nem acesso ao painel da Neon nesta sessão — isso precisa ser feito
por você:

1. Entrar no [console da Neon](https://console.neon.tech), abrir o projeto
   `financas-dashboard`.
2. **Branches → Create branch.** Nome sugerido: `dev`. Origem: `main`, a partir do
   momento atual (não precisa escolher um ponto no passado).
3. Depois de criado, abrir o branch `dev` → **Connect** → copiar a connection string
   **pooled** (a que tem `-pooler` no host, igual a que já está em produção hoje) —
   é a mesma variante que o `lib/prisma.js` atual espera (driver adapter da Neon).
4. Colar essa connection string no seu `.env` local, substituindo o `DATABASE_URL`
   atual (que hoje é o de produção), e adicionar `DATABASE_ENV=development` (já vem
   no `.env.example`) — sem essa variável, qualquer script de teste futuro se recusa
   a rodar (item 3 acima, fail closed).
5. Copiar também a connection string **não-pooled** (mesmo painel **Connect**, sem
   `-pooler` no host) pro `DIRECT_URL` do `.env` — `prisma/schema.prisma` exige essa
   variável separada pra `prisma migrate`/`db push` (Postgres em modo pooled não
   garante os comandos de sessão que Migrate precisa). Faltava no `.env.example`
   até a Fase 5.4F; corrigido lá.
6. Rodar `node scripts/audit.js` uma vez pra confirmar que o `.env` novo está
   funcionando (vai mostrar os mesmos dados de hoje, já que o branch acabou de ser
   copiado — a partir daí os dois branches divergem conforme você usa cada um).

Nada precisa mudar na Vercel — a variável de produção lá já aponta pro branch `main`
e continua apontando.
