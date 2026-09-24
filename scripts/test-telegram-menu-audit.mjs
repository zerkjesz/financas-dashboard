// Fase 7D.1, itens 11, 12 e 15 — AUDITORIA COMPLETA do menu determinístico.
//
// Percorre a árvore inteira a partir de /menu (BFS) e, dentro de cada wizard,
// o grafo de estados (passo a passo, clicando nos botões e alimentando
// textos válidos), provando:
//   - toda função exigida é alcançável a partir de /menu;
//   - nenhum botão morto: TODO callback_data gerado pela UI tem handler
//     (nenhum clique cai em "unhandled"/"stale" dentro do próprio contexto);
//   - nenhum submenu órfão / nenhum submenu referenciado que não existe;
//   - nenhuma chamada a Groq/Anthropic/LLM (fetch espionado) com
//     TELEGRAM_AI_ENABLED=false e SEM chaves de provider no ambiente.
//
// Tudo roda dentro de UMA transação que é revertida no fim (rollback
// proposital) — nenhum dado de fixture nem escrita dos cliques persiste.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

// Prova de independência de LLM: nenhuma chave de provider no processo.
process.env.TELEGRAM_AI_ENABLED = "false";
for (const k of ["GROQ_API_KEY", "GROQ_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "TELEGRAM_AI_PROVIDER"]) delete process.env[k];

const fetchCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) => {
  fetchCalls.push(String(url));
  return Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 200 })); // Telegram "falha" silenciosa, sem rede.
};

const { prisma } = await import("../lib/prisma.js");
const { dispatchUpdate } = await import("../lib/telegramUpdateHandler.js");
const { sentMessages, sentTotal } = await import("../lib/telegramApi.js");
const { MENU_KEYS, HELP_TOPIC_KEYS } = await import("../lib/telegramMenu.js");
const { applyGuardedCorrection, applyGuardedDelete } = await import("../lib/telegramAi/correctionService.js");

let pass = 0,
  fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

class Rollback extends Error {}
const CHAT = "TESTE_AUDIT_chat";
const NAV_PREFIXES = ["wiznav:"];
const TEXT_CANDIDATES = ["50", "Teste", "12/03/2026"];
const MAX_STATES = 600;

function screenOf(before, outbox) {
  const items = [];
  for (const d of (sentTotal() - before > 0 ? sentMessages.slice(-(sentTotal() - before)) : [])) items.push({ text: d.text, kb: d.replyMarkup });
  for (const o of outbox) {
    if (o.type === "sendMessage") items.push({ text: o.args[1], kb: o.args[2]?.replyMarkup });
    else if (o.type === "editMessageText") items.push({ text: o.args[2], kb: o.args[3]?.replyMarkup });
  }
  const withText = items.filter((i) => i.text);
  const last = withText[withText.length - 1];
  return { text: last?.text ?? "", buttons: (last?.kb?.inline_keyboard ?? []).flat().map((b) => ({ text: b.text, data: b.callback_data })), directCount: sentTotal() - before };
}

async function run(tx) {
  const dispatch = async (update) => {
    const outbox = [];
    const before = sentTotal();
    let result;
    let crashed = null;
    // SAVEPOINT por clique: um erro SQL num handler (que aborta a transação
    // no Postgres) vira "botão morto" registrado, sem derrubar a auditoria.
    await tx.$executeRawUnsafe("SAVEPOINT audit_sp");
    try {
      result = await dispatchUpdate(update, CHAT, { client: tx, outbox });
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT audit_sp");
    } catch (err) {
      crashed = err;
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT audit_sp");
    }
    return { result, crashed, screen: screenOf(before, outbox), outbox };
  };
  const click = (data) => dispatch({ callback_query: { id: "audit", data, from: { id: 1 }, message: { message_id: 1, chat: { id: CHAT, type: "private" } } } });
  const text = (t) => dispatch({ message: { text: t, chat: { id: CHAT, type: "private" }, from: { id: 1 } } });
  const clearSession = () => tx.botWizardSession.deleteMany({ where: { chatId: CHAT } });
  const getSession = () => tx.botWizardSession.findUnique({ where: { chatId: CHAT } });
  const restore = async (snap) => {
    await clearSession();
    if (snap) await tx.botWizardSession.create({ data: { chatId: CHAT, flow: snap.flow, step: snap.step, data: snap.data, messageId: snap.messageId ?? null, expiresAt: new Date(Date.now() + 20 * 60 * 1000) } });
  };

  // ---- fixtures (revertidas no rollback final) ----
  const account = await tx.account.findFirst({ where: { type: "checking" } });
  await tx.confirmedCommitment.create({ data: { description: "AUDIT compromisso", amount: 10, dueDate: new Date("2026-12-01"), status: "CONFIRMED" } });
  await tx.contingency.create({ data: { description: "AUDIT contingência", maxAmount: 20, status: "AWAITING_INFORMATION" } });
  await tx.receivable.create({ data: { description: "AUDIT receber", counterparty: "Zé", amount: 30, status: "PENDING" } });
  await tx.goal.create({ data: { name: "AUDIT meta", targetAmount: 100 } });
  const e1 = await tx.expense.create({ data: { amount: 11, description: "AUDIT despesa 1", category: "Outros", accountId: account.id, source: "telegram", confidence: "CONFIRMED", rawMessage: "fixture" } });
  const e2 = await tx.expense.create({ data: { amount: 12, description: "AUDIT despesa 2", category: "Outros", accountId: account.id, source: "telegram", confidence: "CONFIRMED", rawMessage: "fixture" } });
  await tx.income.create({ data: { amount: 13, description: "AUDIT receita", category: "Outros", accountId: account.id, source: "telegram", confidence: "CONFIRMED", rawMessage: "fixture" } });
  await applyGuardedCorrection({ model: "expense", id: e1.id, fieldChanges: { amount: "15.00" }, expectedUpdatedAt: e1.updatedAt.toISOString(), chatId: CHAT }, { client: tx });
  await applyGuardedDelete({ model: "expense", id: e2.id, chatId: CHAT }, { client: tx });

  // =====================================================================
  // A) Árvore de menus a partir de /menu
  // =====================================================================
  const menuScreens = new Map(); // key -> {buttons}
  const referencedMenuKeys = new Set(["root"]);
  const discovered = []; // {screen, text, data}
  const wizardEntries = new Set();
  const deadButtons = [];
  const unhandled = [];

  const root = await text("/menu");
  check("[A] /menu mostra o menu raiz", root.screen.buttons.length > 0 && !root.crashed, String(root.crashed));
  const queue = [{ key: "root", buttons: root.screen.buttons }];
  menuScreens.set("root", root.screen.buttons);

  const clickedData = new Set();
  const readReplies = [];

  while (queue.length) {
    const { key, buttons } = queue.shift();
    for (const b of buttons) {
      discovered.push({ screen: key, ...b });
      if (clickedData.has(`${key}|${b.data}`)) continue;
      clickedData.add(`${key}|${b.data}`);
      await clearSession();
      const r = await click(b.data);
      if (r.crashed) {
        deadButtons.push(`${key} → "${b.text}" (${b.data}): EXCEÇÃO ${r.crashed.message}`);
        continue;
      }
      if (r.result?.callback === "unhandled" || r.result?.callback === "stale") {
        unhandled.push(`${key} → "${b.text}" (${b.data})`);
        continue;
      }
      if (b.data.startsWith("m:")) {
        const target = b.data.slice(2);
        referencedMenuKeys.add(target);
        if (!MENU_KEYS.includes(target)) {
          deadButtons.push(`${key} → "${b.text}" (${b.data}): submenu inexistente`);
          continue;
        }
        if (!menuScreens.has(target)) {
          menuScreens.set(target, r.screen.buttons);
          queue.push({ key: target, buttons: r.screen.buttons });
        }
      } else if (b.data.startsWith("w:")) {
        const flow = b.data.slice(2);
        const s = await getSession();
        const sessionFlow = flow === "saldo_itau" || flow === "saldo_va" ? "saldo" : flow; // saldo_* compartilham o flow "saldo"
        if (!s || s.flow !== sessionFlow || !r.screen.text) deadButtons.push(`${key} → "${b.text}" (${b.data}): wizard não abriu (session=${JSON.stringify(s && { flow: s.flow, step: s.step })})`);
        else wizardEntries.add(flow);
      } else if (b.data.startsWith("r:") || b.data.startsWith("h:")) {
        if (!r.screen.text) deadButtons.push(`${key} → "${b.text}" (${b.data}): resposta vazia`);
        else readReplies.push(b.data);
        if (b.data.startsWith("h:") && r.screen.buttons.some((x) => x.data === "m:ajuda") === false) deadButtons.push(`${b.data}: tópico sem navegação de volta`);
      } else if (b.data.startsWith("cor:")) {
        if (!r.screen.text) deadButtons.push(`${key} → "${b.text}" (${b.data}): resposta vazia`);
        // listas dinâmicas de correção: percorre 1 nível (pick/unsupported/undo).
        for (const sub of r.screen.buttons) {
          if (!sub.data.startsWith("cor:") && !sub.data.startsWith("m:")) continue;
          if (sub.data.startsWith("m:")) continue;
          const k2 = `${b.data}|${sub.data}`;
          if (clickedData.has(k2)) continue;
          clickedData.add(k2);
          discovered.push({ screen: b.data, ...sub });
          if (sub.data.startsWith("cor:delyes:") || sub.data.startsWith("cor:undoyes:")) continue; // ações destrutivas reais são cobertas em test-telegram-correction-undo.mjs.
          await clearSession();
          const r2 = await click(sub.data);
          if (r2.crashed) deadButtons.push(`${b.data} → ${sub.data}: EXCEÇÃO ${r2.crashed.message}`);
          else if (r2.result?.callback === "unhandled" || r2.result?.callback === "stale") unhandled.push(`${b.data} → ${sub.data}`);
          else if (!r2.screen.text && !(await getSession())) deadButtons.push(`${b.data} → ${sub.data}: sem resposta`);
          for (const sub2 of r2.screen.buttons) {
            if (!sub2.data.startsWith("cor:") || sub2.data.startsWith("cor:delyes:") || sub2.data.startsWith("cor:undoyes:")) continue;
            const k3 = `${sub.data}|${sub2.data}`;
            if (clickedData.has(k3)) continue;
            clickedData.add(k3);
            discovered.push({ screen: sub.data, ...sub2 });
            await clearSession();
            const r3 = await click(sub2.data);
            if (r3.crashed) deadButtons.push(`${sub.data} → ${sub2.data}: EXCEÇÃO ${r3.crashed.message}`);
            else if (r3.result?.callback === "unhandled" || r3.result?.callback === "stale") unhandled.push(`${sub.data} → ${sub2.data}`);
          }
        }
      } else {
        deadButtons.push(`${key} → "${b.text}" (${b.data}): prefixo de callback desconhecido no menu`);
      }
    }
  }

  const orphanMenus = MENU_KEYS.filter((k) => !menuScreens.has(k));
  check("[A] nenhum submenu órfão (todo submenu definido é alcançável de /menu)", orphanMenus.length === 0, orphanMenus.join(", "));
  check("[A] nenhum submenu referenciado inexistente", [...referencedMenuKeys].every((k) => MENU_KEYS.includes(k)));

  // ---- cobertura exigida (item 11) ----
  const seen = new Set(discovered.map((d) => d.data));
  const REQUIRED = {
    "REGISTRAR: despesa": "w:gasto", "REGISTRAR: receita": "w:receita", "REGISTRAR: vários": "w:multipla", "REGISTRAR: transferência": "w:transferencia",
    "REGISTRAR: cartão": "w:cartao_compra", "REGISTRAR: parcelado": "w:parcela", "REGISTRAR: recebível": "w:recebivel", "REGISTRAR: compromisso": "w:compromisso", "REGISTRAR: contingência": "w:contingencia",
    "CARTÃO: informar fatura": "w:fatura_atual", "CARTÃO: pagar fatura": "w:fatura_pagar", "CARTÃO: próximas faturas": "r:proximas_faturas", "CARTÃO: parcelas ativas": "r:parcelas_ativas",
    "SALDOS: Itaú": "w:saldo_itau", "SALDOS: VA": "w:saldo_va", "SALDOS: conferir diferenças": "r:diferencas",
    "CONSULTAR A (como eu tô)": "r:summary", "CONSULTAR B (quanto tenho)": "r:balance", "CONSULTAR C (comprometido)": "r:committed", "CONSULTAR D (livre)": "r:free", "CONSULTAR E (seguro)": "r:safe",
    "CONSULTAR F (onde foi)": "m:onde_foi", "CONSULTAR F: este mês": "r:cat:mes", "CONSULTAR F: mês passado": "r:cat:mespassado", "CONSULTAR F: personalizado": "w:categoria_periodo",
    "CONSULTAR G/H (renda)": "r:nextincome", "CONSULTAR I (parcelas aliviam)": "r:installment_relief", "CONSULTAR J (projeção)": "r:projection", "CONSULTAR K (posso comprar)": "w:simulador", "CONSULTAR L (VA)": "r:va",
    "SIMULAR": "w:simulador",
    "PLANEJAMENTO: compromissos": "m:compromissos", "PLANEJAMENTO: contingências": "m:contingencias", "PLANEJAMENTO: recebíveis": "m:recebiveis", "PLANEJAMENTO: metas": "m:metas",
    "COMPROMISSOS: pagar": "w:compromisso_pagar", "COMPROMISSOS: editar": "w:compromisso_editar", "COMPROMISSOS: ver": "r:compromissos_ativos",
    "CONTINGÊNCIAS: atualizar": "w:contingencia_editar", "CONTINGÊNCIAS: resolver": "w:contingencia_resolver", "CONTINGÊNCIAS: ver": "r:contingencias_abertas",
    "RECEBÍVEIS: receber": "w:recebivel_receber", "RECEBÍVEIS: editar": "w:recebivel_editar", "RECEBÍVEIS: ver": "r:recebiveis_pendentes",
    "METAS: ver": "r:metas", "METAS: nova": "w:meta_nova", "METAS: editar": "w:meta_editar",
    "CORREÇÃO: últimos": "cor:recentes", "CORREÇÃO: desfazer último": "cor:undolast", "CORREÇÃO: corrigir": "cor:list", "CORREÇÃO: excluir": "cor:list",
    "AJUDA: atalhos": "h:atalhos",
  };
  const missing = Object.entries(REQUIRED).filter(([, data]) => !seen.has(data));
  check(`[A] TODAS as ${Object.keys(REQUIRED).length} funções exigidas são alcançáveis a partir de /menu`, missing.length === 0, missing.map(([n, d]) => `${n} (${d})`).join("; "));
  check("[A] Ajuda: todos os tópicos têm botão", HELP_TOPIC_KEYS.every((t) => seen.has(`h:${t}`)), HELP_TOPIC_KEYS.filter((t) => !seen.has(`h:${t}`)).join(", "));
  check("[A] correção dinâmica: itens da lista (pick e unsupported) foram percorridos", [...seen].some((d) => d.startsWith("cor:pick:")) && [...seen].some((d) => d.startsWith("cor:unsupported:")));
  check("[A] correção: edição de campo e exclusão alcançáveis a partir do item", [...seen].some((d) => d.startsWith("cor:f:")) && [...seen].some((d) => d.startsWith("cor:delask:")));
  check("[A] desfazer último abre preview com botão de desfazer", [...seen].some((d) => d.startsWith("cor:undoyes:")));

  // =====================================================================
  // B) Grafo de estados de cada wizard
  // =====================================================================
  const seenStates = new Set();
  const callbacksExercised = new Set();
  let statesExplored = 0;
  const sig = (snap, buttons) => `${snap.flow}|${snap.step}|${buttons.map((x) => x.data).join(",")}`;
  const isNav = (data) => NAV_PREFIXES.some((p) => data.startsWith(p));
  const isMenuLevel = (data) => /^(m|w|r|h|cor):/.test(data);
  const groupKey = (data) => data.split(":").slice(0, 2).join(":").replace(/:[A-Za-z0-9_\-À-ú ]*$/, (m) => (m.length > 40 ? ":" : m));

  async function snapshotOf() {
    const s = await getSession();
    return s ? { flow: s.flow, step: s.step, data: s.data, messageId: s.messageId } : null;
  }

  const wq = [];
  for (const flow of wizardEntries) {
    await clearSession();
    const r = await click(`w:${flow}`);
    const snap = await snapshotOf();
    if (snap) wq.push({ snap, buttons: r.screen.buttons });
  }

  while (wq.length && statesExplored < MAX_STATES) {
    const { snap, buttons } = wq.shift();
    const signature = sig(snap, buttons);
    if (seenStates.has(signature)) continue;
    seenStates.add(signature);
    statesExplored++;

    // amostra: primeiro e último botão de cada grupo de prefixo (categorias, meios, etc. compartilham handler).
    const groups = new Map();
    for (const b of buttons) {
      if (isNav(b.data) || isMenuLevel(b.data)) continue;
      const g = b.data.replace(/:.*$/, "");
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(b);
    }
    const toClick = [];
    for (const list of groups.values()) {
      toClick.push(list[0]);
      if (list.length > 1) toClick.push(list[list.length - 1]);
    }

    for (const b of toClick) {
      callbacksExercised.add(b.data);
      await restore(snap);
      const r = await click(b.data);
      if (r.crashed) {
        deadButtons.push(`wizard ${snap.flow}/${snap.step}: "${b.text}" (${b.data}): EXCEÇÃO ${r.crashed.message}`);
        continue;
      }
      if (r.result?.callback === "unhandled" || r.result?.callback === "stale") {
        unhandled.push(`wizard ${snap.flow}/${snap.step}: "${b.text}" (${b.data})`);
        continue;
      }
      const next = await snapshotOf();
      if (next) wq.push({ snap: next, buttons: r.screen.buttons });
    }

    // Passos que esperam texto: só nav como botão útil.
    const forward = buttons.filter((b) => !isNav(b.data) && !isMenuLevel(b.data) && !b.data.startsWith("skip:"));
    if (forward.length === 0 || buttons.some((b) => b.data.startsWith("skip:"))) {
      for (const t of TEXT_CANDIDATES) {
        await restore(snap);
        const r = await text(t);
        if (r.crashed) {
          deadButtons.push(`wizard ${snap.flow}/${snap.step}: texto "${t}": EXCEÇÃO ${r.crashed.message}`);
          continue;
        }
        const next = await snapshotOf();
        if (next && (next.step !== snap.step || next.flow !== snap.flow)) wq.push({ snap: next, buttons: r.screen.buttons });
      }
    }
    // skip: também é um clique (botão de pular)
    for (const b of buttons.filter((x) => x.data.startsWith("skip:"))) {
      callbacksExercised.add(b.data);
      await restore(snap);
      const r = await click(b.data);
      if (r.crashed) deadButtons.push(`wizard ${snap.flow}/${snap.step}: ${b.data}: EXCEÇÃO ${r.crashed.message}`);
      else if (r.result?.callback === "unhandled" || r.result?.callback === "stale") unhandled.push(`wizard ${snap.flow}/${snap.step}: ${b.data}`);
      else {
        const next = await snapshotOf();
        if (next) wq.push({ snap: next, buttons: r.screen.buttons });
      }
    }
  }

  // navegação global do wizard, testada uma vez por tipo (não por estado).
  for (const data of ["wiznav:menu", "wiznav:cancel"]) {
    await restore({ flow: "gasto", step: "valor", data: {}, messageId: null });
    const r = await click(data);
    const s = await getSession();
    check(`[B] ${data} sempre funciona dentro de um wizard (sessão encerrada + menu)`, !r.crashed && !s && r.screen.buttons.length > 0, `crashed=${r.crashed?.message ?? "não"} sessão=${JSON.stringify(s && { flow: s.flow, step: s.step })} botões=${r.screen.buttons.length} callback=${r.result?.callback}`);
  }

  check(`[B] grafo de wizards explorado (${statesExplored} estados, ${callbacksExercised.size} callbacks distintos exercitados)`, statesExplored >= 30, String(statesExplored));
  check("[B] limite de exploração não foi atingido (grafo completo)", statesExplored < MAX_STATES);

  check("[12] DEAD_BUTTONS = 0", deadButtons.length === 0, "\n   " + deadButtons.join("\n   "));
  check("[12] UNHANDLED_CALLBACKS = 0", unhandled.length === 0, "\n   " + unhandled.join("\n   "));

  const unknownPrefix = [...seen, ...callbacksExercised].filter((d) => !/^(m|w|r|h|cor|wiznav|cat|tgt|due|qtd|confirm|pagmenu|bill|pm|date|card|skip|acct|editmenu|editfield|batch|bpm|batchcard|bqtd|bcard|simmode|simpm|simqtd|simcard|simreg|corcat|cpay|cedit|cfield|cgpick|cgstatus|cgeditpick|rpick|reditpick|gpick):?/.test(d));
  check("[12] todo callback_data usa um prefixo conhecido/allowlisted", unknownPrefix.length === 0, unknownPrefix.join(", "));
  const oversized = [...seen, ...callbacksExercised].filter((d) => Buffer.byteLength(d) > 64);
  check("[12] todo callback_data cabe no limite de 64 bytes do Telegram", oversized.length === 0, oversized.join(", "));
  const suspicious = [...seen, ...callbacksExercised].filter((d) => /amount|valor|\d+[.,]\d{2}/i.test(d.replace(/^cor:f:.*:(amount)$/, "")) && !/^(cfield:amount|editfield:valor)$/.test(d));
  check("[12] nenhum callback_data carrega valor financeiro arbitrário", suspicious.length === 0, suspicious.join(", "));

  console.log(`\nDEAD_BUTTONS=${deadButtons.length} UNHANDLED_CALLBACKS=${unhandled.length} ESTADOS=${statesExplored} CALLBACKS_DISTINTOS=${new Set([...seen, ...callbacksExercised]).size}`);
}

let exitCode = 0;
const started = Date.now();
try {
  await prisma
    .$transaction(
      async (tx) => {
        await run(tx);
        throw new Rollback();
      },
      { timeout: 1_800_000, maxWait: 60_000 }
    )
    .catch((err) => {
      if (!(err instanceof Rollback)) throw err;
    });
} catch (err) {
  console.error("💥 Erro:", err);
  exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  await prisma.$disconnect();
}

const llmCalls = fetchCalls.filter((u) => !u.includes("api.telegram.org"));
check("[15] ZERO chamadas de rede fora do Telegram (nenhuma a Groq/Anthropic/LLM) durante a auditoria inteira", llmCalls.length === 0, llmCalls.join(", "));
check("[15] nenhuma chamada a api.groq.com nem api.anthropic.com", !fetchCalls.some((u) => /groq|anthropic/i.test(u)));
console.log(`\ntempo: ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
if (fail > 0) exitCode = 1;
process.exit(exitCode);
