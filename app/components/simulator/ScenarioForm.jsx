"use client";

import Select from "../ui/Select.jsx";
import Input from "../ui/Input.jsx";
import Button from "../ui/Button.jsx";
import { formatMoney } from "@/lib/formatMoney";

// Fase 6.0 (Design Freeze) — RESTYLE PURO. Nenhum campo, binding, validação
// ou required mudou — só a pele visual sobre o mesmo estado (form/onChange)
// e os mesmos cenários condicionais de antes.
//
// Judgment calls documentados (ver relatório final):
// 1) O mock aprovado pede um "slider" de arraste pro valor — este form
//    nunca teve um slider real, sempre foi um <input type="number"> puro.
//    Construir um slider do zero aqui seria interação nova (fora de escopo
//    de um restyle puro) — mantido como o grande campo numérico inline
//    ("Quanto custa"), só com a pele grande/bottom-border do mock.
// 2) O mock pede pills pra "Em quantas vezes" — o real é um
//    <input type="number" min=1 max=60"> de valor livre, não um conjunto
//    fechado de opções (2x/3x/6x/12x...). Transformar isso num seletor de
//    pills reduziria a faixa de valores aceitos hoje (1-60) — mudança de
//    comportamento, não de pele. Mantido como input numérico, só restilizado
//    pro vocabulário visual do freeze.
export default function ScenarioForm({ scenarioType, form, onChange, cards, contingencies, onSubmit, loading, fromContext }) {
  function set(field, value) {
    onChange({ ...form, [field]: value });
  }

  const showBigAmount = scenarioType === "CASH_EXPENSE_NOW" || scenarioType === "CARD_PURCHASE_SINGLE";
  const showInstallments = scenarioType === "CARD_PURCHASE_INSTALLMENTS";

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {(scenarioType === "CARD_PURCHASE_SINGLE" || scenarioType === "CARD_PURCHASE_INSTALLMENTS") && (
        <div>
          <label className="text-eyebrow text-text-muted mb-2 block">Cartão</label>
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
          {fromContext?.cardId && <p className="text-caption text-accent-foreground mt-1">vindo de Cartão</p>}
        </div>
      )}

      {/* "Quanto custa" — campo numérico grande, borda só embaixo, mesmo
          binding real de sempre (form.amount / form.totalAmount). */}
      {showBigAmount && (
        <div>
          <label className="text-eyebrow text-text-muted mb-2 block">Quanto custa</label>
          <div className="flex items-baseline gap-2 border-0 border-b-2 border-border-strong pb-2 focus-within:border-ink transition-colors">
            <span className="text-[28px] sm:text-[36px] font-semibold text-text-muted">R$</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              value={form.amount}
              onChange={(e) => set("amount", e.target.value)}
              placeholder="0,00"
              required
              className="focus-ring w-full min-w-0 bg-transparent text-[28px] sm:text-[36px] font-semibold tabular text-text-primary placeholder:text-text-muted outline-none"
            />
          </div>
        </div>
      )}

      {showInstallments && (
        <>
          <div>
            <label className="text-eyebrow text-text-muted mb-2 block">Quanto custa</label>
            <div className="flex items-baseline gap-2 border-0 border-b-2 border-border-strong pb-2 focus-within:border-ink transition-colors">
              <span className="text-[28px] sm:text-[36px] font-semibold text-text-muted">R$</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0.01"
                value={form.totalAmount}
                onChange={(e) => set("totalAmount", e.target.value)}
                placeholder="0,00"
                required
                className="focus-ring w-full min-w-0 bg-transparent text-[28px] sm:text-[36px] font-semibold tabular text-text-primary placeholder:text-text-muted outline-none"
              />
            </div>
          </div>
          <div>
            <label className="text-eyebrow text-text-muted mb-2 block">Em quantas vezes</label>
            <Input type="number" inputMode="numeric" step="1" min="1" max="60" value={form.installmentCount} onChange={(e) => set("installmentCount", e.target.value)} required className="max-w-[140px]" />
            {form.totalAmount && Number(form.installmentCount) > 0 && (
              <p className="text-caption text-text-muted mt-1.5">{formatMoney(Number(form.totalAmount) / Number(form.installmentCount))} por parcela</p>
            )}
          </div>
        </>
      )}

      {scenarioType === "CONTINGENCY_REALIZATION" && (
        <>
          <div>
            <label className="text-eyebrow text-text-muted mb-2 block">Risco</label>
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
            {fromContext?.contingencyId && <p className="text-caption text-accent-foreground mt-1">simulando este risco</p>}
          </div>
          {/* Ambiguidade real (5.4E.1, item 26/27/28): valor e timing nunca
              pré-decididos silenciosamente quando o risco tem dois valores
              possíveis, ou não tem data conhecida — comportamento intocado. */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-eyebrow text-text-muted mb-2 block">Valor</label>
              <Select value={form.amountField} onChange={(e) => set("amountField", e.target.value)} required>
                {form.amountField === "" && <option value="">Escolha um valor</option>}
                <option value="expected">Esperado</option>
                <option value="max">Máximo</option>
              </Select>
            </div>
            <div>
              <label className="text-eyebrow text-text-muted mb-2 block">Quando?</label>
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
            <p className="text-caption text-warning-text">
              Este risco tem dois valores possíveis (esperado e máximo) — escolha qual simular, nenhum dos dois é "o valor certo".
            </p>
          )}
          {form.timing === "AMBIGUOUS" && (
            <p className="text-caption text-warning-text">Quando isso aconteceria? Este risco não tem uma data conhecida — escolha um cenário de tempo.</p>
          )}
          {form.timing !== "NOW" && form.timing !== "AMBIGUOUS" && (
            <div>
              <label className="text-eyebrow text-text-muted mb-2 block">Data</label>
              {/* Guarda o valor cru do <input type="date"> (string vazia ou
                  "YYYY-MM-DD") — a conversão pra Date só acontece no motor
                  (assertDate), que já trata data inválida como erro normal.
                  Comportamento intocado. */}
              <Input type="date" value={form.timing} onChange={(e) => set("timing", e.target.value)} required />
            </div>
          )}
        </>
      )}

      {scenarioType !== "CONTINGENCY_REALIZATION" && (
        <div>
          <label className="text-eyebrow text-text-muted mb-2 block">Descrição (opcional)</label>
          <Input type="text" value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="ex: Notebook novo" />
        </div>
      )}

      <Button type="submit" variant="accent" loading={loading} className="w-full">
        Simular
      </Button>
    </form>
  );
}
