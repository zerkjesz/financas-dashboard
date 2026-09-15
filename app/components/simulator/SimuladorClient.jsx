"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import ScenarioSelector from "./ScenarioSelector.jsx";
import ScenarioForm from "./ScenarioForm.jsx";
import EmptyResultState from "./EmptyResultState.jsx";
import ResultPanel from "./ResultPanel.jsx";
import Button from "../ui/Button.jsx";

const DEFAULT_FORM = { amount: "", totalAmount: "", installmentCount: "6", cardId: "", contingencyId: "", amountField: "expected", timing: "NOW", description: "" };

// Fase 5.4E — orquestrador do Simulador. Item 20 (crítico): contextual entry
// (query params) NUNCA auto-executa a simulação — só preenche
// scenario/form. O usuário sempre aperta "Simular". Item 46 — query params
// só roteiam apresentação (scenario/cardId/contingencyId), nunca carregam
// JSON/estado financeiro bruto; validados contra as listas reais (cards/
// contingencies) já buscadas — um id inválido/inexistente cai em fallback
// seguro (ignora o prefill), nunca 500.
export default function SimuladorClient() {
  const searchParams = useSearchParams();
  const [scenarioType, setScenarioType] = useState("CASH_EXPENSE_NOW");
  const [cards, setCards] = useState([]);
  const [contingencies, setContingencies] = useState([]);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [fromContext, setFromContext] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/cards").then((r) => r.json()),
      fetch("/api/dashboard").then((r) => r.json()),
    ])
      .then(([cardsData, dashData]) => {
        const cardList = Array.isArray(cardsData) ? cardsData : [];
        const contingencyList = dashData?.financial?.contingency?.items || [];
        setCards(cardList);
        setContingencies(contingencyList);

        // BUG REAL corrigido (achado ao vivo): com 1 único cartão, o
        // <select> não mostra a opção vazia "Selecione um cartão" — o
        // <select> nativo então RENDERIZA o único cartão visualmente, mas o
        // estado React (form.cardId) continuava "" (nunca sincronizado),
        // e o submit falhava com "cardId é obrigatório". Corrigido:
        // pré-seleciona o único cartão real no ESTADO também — não é uma
        // escolha ambígua (item 51: com >1 cartão, nunca pré-seleciona
        // nenhum silenciosamente).
        if (cardList.length === 1) {
          setForm((f) => ({ ...f, cardId: cardList[0].id }));
        }
        // Mesmo bug, mesma causa, achado ao vivo na 2ª rodada de testes: com
        // 1 único risco/contingência, o <select> também omite a opção vazia
        // (mesma condição `length > 1` em ScenarioForm.jsx) e o estado
        // React (form.contingencyId) ficava sem sincronizar — submit falhava
        // com "contingencyId é obrigatório". Mesma correção, mesmo cuidado
        // (item 51): com >1 risco, nunca pré-seleciona nenhum.
        if (contingencyList.length === 1) {
          setForm((f) => ({ ...f, contingencyId: contingencyList[0].id }));
        }

        // Prefill a partir de contexto (item 13/15) — só aplica se o valor
        // referenciado existe DE VERDADE na lista real (nunca confia em
        // query string arbitrária).
        const scenarioParam = searchParams.get("scenario");
        const cardIdParam = searchParams.get("cardId");
        const contingencyIdParam = searchParams.get("contingencyId");

        if (scenarioParam === "card_single" || scenarioParam === "card_installments") {
          const cardExists = cardIdParam && cardList.some((c) => c.id === cardIdParam);
          setScenarioType(scenarioParam === "card_installments" ? "CARD_PURCHASE_INSTALLMENTS" : "CARD_PURCHASE_SINGLE");
          if (cardExists) {
            setForm((f) => ({ ...f, cardId: cardIdParam }));
            setFromContext({ cardId: cardIdParam });
          }
        } else if (scenarioParam === "risk") {
          const contingency = contingencyIdParam ? contingencyList.find((c) => c.id === contingencyIdParam) : null;
          setScenarioType("CONTINGENCY_REALIZATION");
          if (contingency) {
            // Fase 5.4E.1, item 26/27/28 (CRÍTICO) — entrada contextual NUNCA
            // decide silenciosamente por escolhas ambíguas do risco real:
            // se o risco tem expectedAmount E maxAmount (dois valores
            // válidos e diferentes — ex: um risco com R$1.000 esperado vs
            // R$2.000 máximo, 2x de diferença), o form chega SEM valor
            // pré-selecionado, forçando escolha consciente (ScenarioForm
            // mostra um placeholder real + required, nunca um dos dois
            // silenciosamente marcado). Mesma lógica pra timing: se
            // expectedDate é null (timing desconhecido — caso real e comum
            // em riscos recém-cadastrados), NUNCA assume "Agora" — força
            // escolha explícita. Só pré-seleciona quando não há ambiguidade
            // de verdade (ex: só existe expectedAmount, sem maxAmount — nesse
            // caso não há segunda opção real pra esconder).
            const amountAmbiguous = contingency.expectedAmount != null && contingency.maxAmount != null && contingency.expectedAmount !== contingency.maxAmount;
            const timingAmbiguous = !contingency.expectedDate;
            setForm((f) => ({
              ...f,
              contingencyId: contingencyIdParam,
              amountField: amountAmbiguous ? "" : contingency.expectedAmount != null ? "expected" : "max",
              // "AMBIGUOUS" é um sentinel distinto de "" — "" já significa
              // "usuário escolheu Data específica, ainda não digitou a
              // data" (comportamento pré-existente do <input type="date">).
              // Precisam ser estados diferentes: um é decisão pendente
              // (nunca vista pelo usuário), o outro é formulário incompleto
              // no meio do preenchimento normal.
              timing: timingAmbiguous ? "AMBIGUOUS" : f.timing,
            }));
            setFromContext({ contingencyId: contingencyIdParam });
          }
        }
        setDataLoaded(true);
      })
      .catch(() => setDataLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeScenario(type) {
    setScenarioType(type);
    setResult(null);
    setError(null);
  }

  function resetScenario() {
    setForm(DEFAULT_FORM);
    setResult(null);
    setError(null);
    setFromContext(null);
  }

  async function handleSimulate(e) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);

    let payload = { type: scenarioType };
    if (scenarioType === "CASH_EXPENSE_NOW") {
      payload.amount = Number(form.amount);
      if (form.description) payload.description = form.description;
    } else if (scenarioType === "CARD_PURCHASE_SINGLE") {
      payload.cardId = form.cardId;
      payload.amount = Number(form.amount);
      if (form.description) payload.description = form.description;
    } else if (scenarioType === "CARD_PURCHASE_INSTALLMENTS") {
      payload.cardId = form.cardId;
      payload.totalAmount = Number(form.totalAmount);
      payload.installmentCount = Number(form.installmentCount);
      if (form.description) payload.description = form.description;
    } else if (scenarioType === "CONTINGENCY_REALIZATION") {
      payload.contingencyId = form.contingencyId;
      payload.timing = form.timing;
      payload.amountField = form.amountField;
    }

    try {
      const res = await fetch("/api/simulate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Erro ao simular");
      } else {
        setResult(data);
      }
    } catch {
      setError("Erro de rede ao simular. Seus dados no formulário continuam aqui.");
    } finally {
      setLoading(false);
    }
  }

  if (!dataLoaded) return null;

  return (
    <div>
      <header className="mb-6">
        <div className="text-eyebrow text-text-muted mb-1.5">Simulador</div>
        <h1 className="text-page-title text-text-primary mb-1.5">Posso comprar isso?</h1>
        <p className="text-caption text-text-muted">
          Responde "e se…?" usando a mesma verdade financeira do resto do produto — <span className="text-text-secondary">simular nunca altera seus dados reais</span>.
        </p>
      </header>

      {/* Painel de entrada (max 360px, cresce até 300px de base) + painel de
          resultado (cresce muito mais rápido, base 420px) — empilha em
          coluna abaixo de lg, igual ao mock aprovado. */}
      <div className="flex flex-col lg:flex-row gap-4 items-start">
        <div className="w-full lg:max-w-[360px] lg:[flex:1_1_300px] space-y-4">
          <ScenarioSelector value={scenarioType} onChange={changeScenario} />
          <div className="rounded-card bg-surface shadow-card p-6">
            <ScenarioForm
              scenarioType={scenarioType}
              form={form}
              onChange={setForm}
              cards={cards}
              contingencies={contingencies}
              onSubmit={handleSimulate}
              loading={loading}
              fromContext={fromContext}
            />
          </div>
          {error && (
            <div role="alert" className="rounded-control bg-danger-bg p-3 text-sm text-danger-text">
              {error}
            </div>
          )}
          {(result || fromContext) && (
            // Fase 5.4E.1.1 — MEDIDO ao vivo: 17px real (nem flex, nem
            // padding). `inline-flex items-center` + `pointer-coarse:min-h-11`
            // só em touch — texto/cor ficam idênticos em desktop.
            <button
              type="button"
              onClick={resetScenario}
              className="focus-ring inline-flex items-center text-caption text-text-muted hover:text-text-primary cursor-pointer pointer-coarse:min-h-11"
            >
              limpar cenário
            </button>
          )}
        </div>

        <div className="w-full lg:[flex:999_1_420px] min-w-0">{result ? <ResultPanel result={result} /> : <EmptyResultState />}</div>
      </div>
    </div>
  );
}
