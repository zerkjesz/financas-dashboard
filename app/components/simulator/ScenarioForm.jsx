"use client";

import Input from "../ui/Input.jsx";
import Select from "../ui/Select.jsx";
import Button from "../ui/Button.jsx";
import { formatMoney } from "@/lib/formatMoney";

// Fase 5.4E, item 10 — form density: cada cenário mostra SÓ os campos que
// precisa (nunca os 4 conjuntos de campos ao mesmo tempo). Item 11 — inputs
// numéricos usam inputMode/step apropriados; card selector usa nome humano
// (nunca id cru). Item 12 — nenhuma ambiguidade resolvida em silêncio: os
// campos obrigatórios do engine (cardId, contingencyId, timing) são
// obrigatórios aqui também, o form não deixa simular sem eles.
export default function ScenarioForm({ scenarioType, form, onChange, cards, contingencies, onSubmit, loading, fromContext }) {
  function set(field, value) {
    onChange({ ...form, [field]: value });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {(scenarioType === "CARD_PURCHASE_SINGLE" || scenarioType === "CARD_PURCHASE_INSTALLMENTS") && (
        <div>
          <label className="text-caption text-text-muted mb-1 block">Cartão</label>
          {cards.length === 0 ? (
            <p className="text-body text-text-muted">Nenhum cartão cadastrado ainda — este cenário precisa de um cartão real.</p>
          ) : (
            <Select value={form.cardId} onChange={(e) => set("cardId", e.target.value)} required>
              {cards.length > 1 && <option value="">Selecione um cartão</option>}
              {cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — limite disponível {formatMoney(c.availableLimit)}
                </option>
              ))}
            </Select>
          )}
          {fromContext?.cardId && <p className="text-caption text-accent mt-1">vindo de Cartão</p>}
        </div>
      )}

      {(scenarioType === "CASH_EXPENSE_NOW" || scenarioType === "CARD_PURCHASE_SINGLE") && (
        <div>
          <label className="text-caption text-text-muted mb-1 block">Valor (R$)</label>
          <Input type="number" inputMode="decimal" step="0.01" min="0.01" value={form.amount} onChange={(e) => set("amount", e.target.value)} required />
        </div>
      )}

      {scenarioType === "CARD_PURCHASE_INSTALLMENTS" && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-caption text-text-muted mb-1 block">Valor total (R$)</label>
            <Input type="number" inputMode="decimal" step="0.01" min="0.01" value={form.totalAmount} onChange={(e) => set("totalAmount", e.target.value)} required />
          </div>
          <div>
            <label className="text-caption text-text-muted mb-1 block">Parcelas</label>
            <Input type="number" inputMode="numeric" step="1" min="1" max="60" value={form.installmentCount} onChange={(e) => set("installmentCount", e.target.value)} required />
          </div>
        </div>
      )}

      {scenarioType === "CONTINGENCY_REALIZATION" && (
        <>
          <div>
            <label className="text-caption text-text-muted mb-1 block">Risco</label>
            {contingencies.length === 0 ? (
              <p className="text-body text-text-muted">Nenhum risco em aberto cadastrado ainda — este cenário precisa de um risco real.</p>
            ) : (
              <Select value={form.contingencyId} onChange={(e) => set("contingencyId", e.target.value)} required>
                {contingencies.length > 1 && <option value="">Selecione um risco</option>}
                {contingencies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.description} (esperado {c.expectedAmount != null ? formatMoney(c.expectedAmount) : "—"} · máximo {formatMoney(c.maxAmount)})
                  </option>
                ))}
              </Select>
            )}
            {fromContext?.contingencyId && <p className="text-caption text-accent mt-1">simulando este risco</p>}
          </div>
          {/* Fase 5.4E.1, item 26/27/28 (CRÍTICO) — ambiguity audit da
              entrada contextual: quando o risco selecionado tem
              expected E máximo diferentes, o valor NUNCA chega pré-marcado
              (SimuladorClient.jsx deixa form.amountField = "" nesse caso) —
              o <select> mostra um placeholder real ("Escolha um valor"),
              `required`, e uma legenda explícita explica a decisão. Mesma
              lógica pra timing quando o risco não tem expectedDate
              conhecido: NUNCA assume "Agora" silenciosamente. */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-caption text-text-muted mb-1 block">Valor</label>
              <Select value={form.amountField} onChange={(e) => set("amountField", e.target.value)} required>
                {form.amountField === "" && <option value="">Escolha um valor</option>}
                <option value="expected">Esperado</option>
                <option value="max">Máximo</option>
              </Select>
            </div>
            <div>
              <label className="text-caption text-text-muted mb-1 block">Quando?</label>
              <Select
                value={form.timing === "AMBIGUOUS" ? "" : form.timing === "NOW" ? "NOW" : "DATE"}
                onChange={(e) => set("timing", e.target.value === "NOW" ? "NOW" : "")}
                required
              >
                {form.timing === "AMBIGUOUS" && <option value="">Escolha quando</option>}
                <option value="NOW">Agora</option>
                <option value="DATE">Data específica</option>
              </Select>
            </div>
          </div>
          {form.amountField === "" && (
            <p className="text-caption text-warning">
              Este risco tem dois valores possíveis (esperado e máximo) — escolha qual simular, nenhum dos dois é "o valor certo".
            </p>
          )}
          {form.timing === "AMBIGUOUS" && (
            <p className="text-caption text-warning">Quando isso aconteceria? Este risco não tem uma data conhecida — escolha um cenário de tempo.</p>
          )}
          {form.timing !== "NOW" && form.timing !== "AMBIGUOUS" && (
            <div>
              <label className="text-caption text-text-muted mb-1 block">Data</label>
              {/* BUG REAL corrigido (achado ao vivo): a versão anterior convertia
                  e.target.value pra ISO completo (new Date(...).toISOString())
                  dentro do próprio onChange. Dois problemas reais: (1) um
                  <input type="date"> nativo pode disparar onChange com valor
                  vazio/incompleto enquanto o usuário ainda está digitando (ex:
                  só o dia preenchido) — nesse caso o Date construído é inválido
                  e .toISOString() lança RangeError, derrubando todo o
                  SimuladorClient (React error boundary, tela em branco). (2) o
                  ISO completo resultante ("2026-11-08T00:00:00.000Z") não é um
                  "YYYY-MM-DD" válido pro atributo value de <input type="date">
                  — o navegador rejeita e o campo volta a mostrar vazio mesmo
                  com o estado React correto, parecendo que a data "sumiu".
                  Correção: o form guarda o valor cru do input (string vazia ou
                  "YYYY-MM-DD", sempre válido pro próprio <input type="date">);
                  a conversão pra Date só acontece no motor (financialSimulator.
                  assertDate), que já trata data inválida como
                  SimulationInputError normal — nunca um crash. */}
              <Input type="date" value={form.timing} onChange={(e) => set("timing", e.target.value)} required />
            </div>
          )}
        </>
      )}

      {scenarioType !== "CONTINGENCY_REALIZATION" && (
        <div>
          <label className="text-caption text-text-muted mb-1 block">Descrição (opcional)</label>
          <Input type="text" value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="ex: Notebook novo" />
        </div>
      )}

      <Button type="submit" loading={loading}>
        Simular
      </Button>
    </form>
  );
}
