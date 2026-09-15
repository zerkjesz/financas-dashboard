import { formatMoney, formatDate } from "@/lib/formatMoney";

const WEEKDAY = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

// Fase 6.0 (Design Freeze) — card lime "a próxima renda alivia" da
// referência aprovada. O dia da semana é computado de verdade a partir de
// `nextIncome.expectedDate` (o mock tinha "Sexta" hardcoded) — nunca um
// texto fixo. `committedAmount`/`baseCommittedPercent` continuam vindo
// exclusivamente de `financial.nextIncomeCommitment` (lib/freeMoney.js).
export default function NextIncomeSpotlight({ nextIncome, nextIncomeCommitment }) {
  if (!nextIncome?.expectedDate) return null;

  const weekday = WEEKDAY[new Date(nextIncome.expectedDate).getUTCDay()];
  const committed = nextIncomeCommitment?.committedAmount ?? 0;
  const realLeftover = Math.max(0, nextIncome.baseAmount - committed);
  const overCommitted = committed > nextIncome.baseAmount;

  return (
    <div className="relative overflow-hidden rounded-card bg-accent p-7 text-accent-foreground">
      <div className="pointer-events-none absolute -bottom-16 -left-16 h-56 w-56 rounded-full bg-ink/5" aria-hidden="true" />
      <div className="relative">
        <div className="text-eyebrow text-ink/60 mb-2">{weekday.charAt(0).toUpperCase() + weekday.slice(1)}, a renda cai</div>
        <div className="text-metric-lg mb-1">+{formatMoney(nextIncome.baseAmount)}</div>
        <div className="text-caption text-ink/60 mb-5">{formatDate(nextIncome.expectedDate)}</div>

        <div className="grid grid-cols-2 gap-3 border-t border-ink/10 pt-4">
          <div>
            <div className="text-eyebrow text-ink/55 mb-1">Já tem dono</div>
            <div className="tabular text-sm font-semibold">{formatMoney(committed)}</div>
          </div>
          <div>
            <div className="text-eyebrow text-ink/55 mb-1">Sobra de verdade</div>
            <div className="tabular text-base font-bold">{formatMoney(realLeftover)}</div>
          </div>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-ink/70">
          {overCommitted
            ? "Já tem mais compromisso do que essa renda cobre — vale acompanhar de perto."
            : "Segure os gastos novos até lá — o que sobra depois dos compromissos é a folga real."}
        </p>
      </div>
    </div>
  );
}
