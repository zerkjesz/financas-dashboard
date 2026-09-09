"use client";

import { useEffect, useState } from "react";
import PageContainer from "../components/ui/PageContainer.jsx";
import { DashboardSkeleton } from "../components/Skeleton.jsx";
import CurrentHorizonSection from "../components/commitments/CurrentHorizonSection.jsx";
import ObligationBucket from "../components/commitments/ObligationBucket.jsx";
import NextIncomeWindowSection from "../components/commitments/NextIncomeWindowSection.jsx";
import RunoffChart from "../components/commitments/RunoffChart.jsx";
import RiskSection from "../components/commitments/RiskSection.jsx";
import BillsManager from "../components/commitments/BillsManager.jsx";

// Fase 5.4D — COMPROMISSOS responde "o que eu tenho que pagar, quando e com
// qual grau de certeza?" (item 25). NÃO é uma lista de Prisma models (item
// 25) — é a MESMA verdade classificada que a Home usa (financial.*, de
// lib/productFinancialSnapshot.js), só com mais profundidade: cada bucket
// de horizonte vira sua própria seção, em vez de 1 motivo dominante + "ver
// mais". Bills CRUD (Bill model) continua funcionando exatamente igual —
// só a apresentação mudou (item 33).
export default function CompromissosPage() {
  const [financial, setFinancial] = useState(null);
  const [bills, setBills] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);

  // Item 69 — auditado antes de adicionar fetch novo: financial.externalInstallments.runoff
  // (via /api/dashboard, já buscado abaixo) já é o MESMO computeExternalInstallmentRunoff
  // que /api/external-installments exporia — buscar os dois seria 2 fontes da mesma
  // verdade por acaso coincidindo, nunca reconciliadas entre si. Só um fetch.
  async function load() {
    setLoading(true);
    const [dashRes, billsRes, accountsRes] = await Promise.all([fetch("/api/dashboard"), fetch("/api/bills"), fetch("/api/accounts")]);
    setFinancial((await dashRes.json()).financial);
    setBills(await billsRes.json());
    setAccounts(await accountsRes.json());
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  if (loading || !financial) {
    return <DashboardSkeleton />;
  }

  const { currentObligations, nextIncomeCommitment, futureObligations, contingency } = financial;
  const incurred = currentObligations.breakdown.filter((i) => i.class === "INCURRED_LIABILITY");
  const dueBeforeIncome = currentObligations.breakdown.filter((i) => i.class === "CURRENT_HORIZON_OBLIGATION");

  return (
    <PageContainer>
      <header className="mb-6">
        <h1 className="text-page-title text-text-primary">Compromissos</h1>
        <p className="text-caption text-text-muted">O que você precisa pagar, quando, e com qual grau de certeza</p>
      </header>

      <div className="space-y-4">
        <CurrentHorizonSection
          incurred={incurred}
          incurredTotal={currentObligations.incurredLiabilities}
          dueBeforeIncome={dueBeforeIncome}
          dueBeforeIncomeTotal={currentObligations.dueBeforeNextIncome}
        />

        <NextIncomeWindowSection nextIncomeCommitment={nextIncomeCommitment} nextWindowItems={financial.externalInstallments.nextWindowItems} />

        <ObligationBucket
          title="Mais pra frente"
          subtitle="Depois da próxima renda — conhecimento, não urgência."
          items={futureObligations.decomposition.map((d) => ({ description: `${d.count} ${d.model === "CardBill" ? "fatura(s)" : d.model === "ExternalInstallment" ? "parcela(s) externa(s)" : d.model === "ConfirmedCommitment" ? "compromisso(s)" : "conta(s)"}`, amount: d.amount, class: null }))}
          total={futureObligations.amount}
          muted
        />

        <RunoffChart runoff={financial.externalInstallments.runoff} />

        <RiskSection contingency={contingency} />

        <BillsManager bills={bills} accounts={accounts} onChanged={load} />
      </div>
    </PageContainer>
  );
}
