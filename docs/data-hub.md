# Data Hub — Exportação e Importação de Dados

Fase 6.0 (Design Freeze). Área "Dados" (`/dados`) — a única superfície do produto
onde o usuário pode levar uma cópia completa do que o Norte sabe, ou trazer dados
de fora pra dentro do banco real, com segurança e auditoria de verdade.

Toda mutação de import passa pelo mesmo `middleware.js` (auth + CSRF) de qualquer
outra rota do produto — nenhuma exceção foi criada para o Data Hub.

## Exportação

`GET /api/data/export` — gera um `.xlsx` sob demanda (`lib/dataHub/export.js`),
nunca persistido em disco no servidor.

- **28 abas**: 24 abas RAW (uma por model relevante do schema — ver tabela abaixo)
  + `Resumo` (metadados do arquivo: versão do schema, período, timezone) +
  `Indicadores` + `Projeções` (leitura da mesma verdade financeira do produto —
  `buildProductFinancialSnapshot`/`buildBaseProjection`, nunca recalculada aqui) +
  `Dicionário de dados` (descrição de cada coluna de cada aba).
- **Tipos Excel corretos**: dinheiro como número com `numFmt` de moeda (nunca
  string), datas como `Date` com `numFmt` `dd/mm/yyyy` (ou `dd/mm/yyyy hh:mm` pra
  datetime), booleanos como boolean real.
- **Defesa contra injeção de fórmula**: qualquer string começando com `= + - @`
  recebe um prefixo `'` antes de ir pra célula (`sanitizeString`, `export.js`) —
  nunca abre um app de planilha em uma fórmula controlada por dado do usuário.
- **Nunca exportado**: sessão, tokens, segredos, rate-limit, `PendingBotMessage`/
  `BotWizardSession` (estado interno do bot, não é dado financeiro do usuário).
- **Metadados preservados**: `id`, `createdAt`/`updatedAt`, `source` (manual/
  telegram/migration/import) e `confidence` aparecem nas abas onde existem no
  schema — nunca descartados só pra simplificar a planilha.
- **Customização** (`ExportPanel.jsx`): período (todo o histórico ou um recorte) e
  seleção de abas — "baixar tudo" é sempre a opção primária/em destaque.

### As 24 abas RAW

| Aba | Model | Importável? |
|---|---|---|
| Contas | Account | não (nunca criado/editado por planilha) |
| Cartões | Card | não |
| Receitas | Income | **sim** |
| Despesas | Expense | **sim** |
| Transferências | Transfer | **sim** |
| Ajustes de saldo | BalanceAdjustment | **sim** |
| Atualizações de limite | CardLimitUpdate | não |
| Compras | Purchase | não |
| Parcelas | Installment | não |
| Faturas | CardBill | não |
| Regras recorrentes | RecurringRule | não |
| Contas a pagar | Bill | **sim** |
| Metas | Goal | **sim** |
| Reservas | Reserve | não |
| Movimentos de reserva | ReserveMovement | não |
| Planos de parcela externa | ExternalInstallmentPlan | não |
| Parcelas externas | ExternalInstallment | não |
| Compromissos confirmados | ConfirmedCommitment | **sim** |
| Contingências | Contingency | **sim** |
| Valores a receber | Receivable | **sim** |
| Orçamento por categoria | CategoryBudget | **sim** |
| Movimentos de crédito do cartão | (crédito de fatura) | não |
| Configurações | AppSettings | não |
| Histórico legado | LegacyTransaction | não |

Um dataset marcado "não" é **export-only por decisão de segurança/integridade**,
não por falta de tempo: são registros derivados (parcelas de uma compra),
âncoras cuja edição livre quebraria o cálculo de saldo/limite (`BalanceAdjustment`
é importável porque É a âncora; `CardLimitUpdate` não, porque cartão tem uma
única fonte hoje), ou dados que exigiriam um adapter dedicado de
compra-com-parcelas que não existe ainda (Purchase/Installment). A UI de import
(`ImportWizard.jsx`) nunca oferece um dataset sem adapter — a lista vem do mesmo
`ADAPTERS` que valida no servidor, não de uma lista solta duplicada no cliente.

## Importação

Pipeline real, sempre nesta ordem: **UPLOAD → PARSE → VALIDATE → NORMALIZE →
MATCH → DRY-RUN/PREVIEW → CONFLICT RESOLUTION → CONFIRM → APPLY → AUDIT**. Nunca
escreve no banco só por causa do upload — só `POST /api/data/import/apply`
escreve, e só depois de um preview explícito do mesmo `batchId`.

### 1. Upload e parse (`POST /api/data/import/preview`)

Tudo validado no servidor, nunca confiando em checagem do cliente:

- Tamanho máximo: **15 MB**.
- Máximo de **60 abas** por arquivo.
- Máximo de **20.000 linhas** por aba.
- XLSX é um ZIP — os limites acima existem justamente pra evitar decompression-
  bomb (arquivo pequeno que descomprime em algo enorme).
- Célula de fórmula nunca é lida como fórmula — só `.result` é usado; `.formula`
  é ignorado (`parse.js`).
- Versão do schema (`Resumo.schemaVersion`) é detectada e comparada a
  `EXPORT_SCHEMA_VERSION` ("6.0.0"); uma versão desconhecida não trava a
  importação (permite planilha editada manualmente), mas o preview reporta
  `schemaVersionKnown: false` pra UI avisar o usuário.
- Cada aba recebe um relatório (`sheetReports`): linhas lidas, colunas faltando,
  colunas desconhecidas, se é importável.

### 2. Match e diff (`lib/dataHub/plan.js`)

Cada linha do arquivo é classificada, por adapter, em:

- **`id` (alta confiança)** — linha tem uma coluna `ID` que bate com um registro
  existente → vira **atualização automática** (só os campos que realmente mudam).
- **chave natural (conflito)** — sem `ID`, mas casa por uma combinação natural
  (ex.: Metas por nome; Contas a pagar por descrição+vencimento) com exatamente
  1 candidato → vira **"Conflito"**, precisa de decisão humana: **Manter o
  atual** / **Usar o do arquivo** / **Ver depois**.
- **ambíguo (inválido)** — chave natural casa com 2+ candidatos → nunca escolhe
  sozinho; fica bloqueado até o arquivo trazer o `ID` explícito.
- **sem chave (novo)** — não tem `ID` nem chave natural confiável (é o caso de
  todo lançamento de ledger — receita/despesa/transferência/ajuste: descrição +
  valor + data podem legitimamente repetir por coincidência, então nunca se
  adivinha um match) → sempre vira **criação** em modo Adicionar, e é ignorada
  ("sem correspondência") em modo Atualizar.

Ledgers (Receitas/Despesas/Transferências/Ajustes) **só entram nos modos
Adicionar/Atualizar por ID** — nunca por chave natural, porque não têm uma.
Cadastros (Metas/Contas a pagar/Compromissos/Contingências/Recebíveis/Orçamento)
usam `buildNaturalKeyAdapter` com uma chave específica por domínio.

### 3. Os 3 modos

- **Adicionar** — só cria o que é novo; nunca toca no que já existe.
- **Atualizar** — cruza pelos registros existentes (ID ou chave natural) e só
  muda o que realmente mudou; nunca cria uma linha nova sem chave.
- **Substituir** — **nunca significa apagar o banco**. Escopo fixo e explícito:
  `REPLACEABLE_DATASETS = ["incomes", "expenses", "transfers"]`, dentro de um
  período escolhido pelo usuário. Metas, cartões, limites, reservas, parcelas
  externas, compromissos, contingências, recebíveis — **tudo continua igual**.
  Antes de apagar qualquer linha do período, `lib/dataHub/replace.js` exclui da
  exclusão qualquer receita/despesa referenciada por
  `ExternalInstallment.expenseId`, `ConfirmedCommitment.expenseId` ou
  `Receivable.incomeId` — nunca deixa órfão um vínculo que o schema até
  permitiria (`onDelete: SetNull`), mesmo sem o Postgres reclamar.
  **Confirmação destrutiva obrigatória**: o servidor exige a frase exata
  `SUBSTITUIR` digitada (`confirmText`), checada tanto na UI quanto na API — não
  é só um "tem certeza?" de um clique.

### 4. Dry-run == apply (mesma lógica, nunca duas implementações)

`planImport`/`planReplace` (preview) e `applyImportBatch`/`applyReplace` (apply)
compartilham exatamente o mesmo código de match/diff/adapter — o preview nunca é
uma função "parecida" separada. O preview de verdade não escreve nada; só quem
prova isso é o próprio teste de integração (`scripts/test-data-hub.mjs`), que
roda o dry-run e confere zero linha nova no banco antes de chamar apply.

### 5. Concorrência otimista e expiração

- O preview carrega um **fingerprint** (`{model, id, updatedAt}` por linha
  afetada) junto com o plano.
- No apply, o fingerprint é revalidado contra o estado atual do banco
  (`fingerprintStillValid`); se qualquer registro mudou entre o preview e o
  apply, a operação inteira é abortada com `stale_import` (409) — nunca aplica
  um plano desatualizado silenciosamente. O usuário precisa validar de novo.
- Todo `ImportBatch` tem `expiresAt` (janela de revisão); expirado, o apply
  recusa com `batch_expired` e pede um novo upload.

### 6. Idempotência e atomicidade

- `applyImportBatch`/`applyReplace` rodam dentro de uma transação Prisma —
  tudo ou nada.
- Reaplicar o **mesmo `batchId`** já aplicado nunca reexecuta a mutação: a rota
  detecta `status === "APPLIED"` e devolve os mesmos contadores já registrados
  na 1ª aplicação (`alreadyApplied: true`), sem tocar no banco de novo.

### 7. Undo real (24h) — não é uma promessa vazia

Quando a cópia do Norte no ZIP de design original dizia "dá pra desfazer por
24h", a decisão desta fase foi **implementar de verdade**, não suavizar a copy:

- No apply, cada linha alterada tem seu estado **anterior** capturado
  (`preimages` — `serializePreimage`, que converte `Decimal`→number e
  `Date`→ISO string pra caber em uma coluna `Json`).
- `POST /api/data/import/undo` (dentro de `undoDeadline`, 24h) restaura cada
  preimage (`reviveRow` faz o caminho inverso: string ISO → `Date` real, exigido
  pelo Prisma Client) ou apaga a linha se ela não existia antes (caso de uma
  criação pura).
- Fora da janela de 24h, `UndoWindowExpiredError` — undo recusado com mensagem
  clara, nunca falha silenciosamente.
- Undo em si é auditado (`IMPORT_UNDO`) e também roda em transação.

### 8. Auditoria (`GET /api/data/activity`)

Toda operação relevante vira uma linha em `DataOperation`: `EXPORT`,
`IMPORT_PREVIEW`, `IMPORT_APPLY`, `IMPORT_FAILED`, `IMPORT_UNDO` — com
mode/datasets/fileName/fileHash/contadores, nunca com o conteúdo do arquivo ou
qualquer segredo. `importBatchId` (campo `@unique` em `DataOperation`) linka
especificamente a operação **IMPORT_APPLY** ao seu `ImportBatch`, usada pelo
lookup de idempotência do item 6 — por isso `IMPORT_PREVIEW`, `IMPORT_FAILED` e
`IMPORT_UNDO` deliberadamente **não** setam esse campo (ver Nota de correção
abaixo).

## Nota de correção (achado da QA visual desta fase)

Durante a verificação end-to-end em navegador (preview → apply → undo reais
contra o DEV, não só via script), foi encontrado e corrigido um bug real: a
rota de preview gravava sua própria `DataOperation` de auditoria já com
`importBatchId` setado, o mesmo campo `@unique` que a rota de apply usa depois
pra gravar a *sua* `DataOperation` — toda vez que um apply real acontecia
(sempre precedido de um preview, por design), o `create()` do apply colidia com
a constraint única e retornava 500 com a mensagem "nada foi aplicado". Na
prática, a mutação real e o `ImportBatch.status = APPLIED` **já tinham sido
commitados** antes desse erro — ou seja, o dado era aplicado de verdade, mas o
usuário recebia uma mensagem de erro dizendo o contrário. Corrigido em duas
partes: (1) o registro de preview não seta mais `importBatchId`; (2) a escrita
do log de auditoria do apply foi isolada em seu próprio `try/catch` — uma falha
nesse passo (que já ocorre depois da mutação real estar commitada) nunca mais
pode virar uma resposta "apply_failed" enganosa pro cliente. Validado
novamente via ciclo real preview→apply→retry-idempotente→undo contra o DEV.

## Limitações conhecidas

- Compras parceladas (`Purchase`/`Installment`) e Faturas de cartão
  (`CardBill`) são export-only — não há adapter de import pra elas nesta fase
  (exigiriam um fluxo de criação-com-parcelas-derivadas dedicado, fora do
  escopo desta fase pra não introduzir complexidade desproporcional a um app
  pessoal).
- Formato de importação é **exclusivamente XLSX** — CSV não é oferecido em
  lugar nenhum da UI (não é uma feature "quase pronta" escondida; simplesmente
  não existe, coerente com o parser real do backend).
- Substituir está restrito às 3 tabelas do ledger (Receitas/Despesas/
  Transferências) — nenhuma outra tabela tem um modo de substituição em massa
  nesta fase.
