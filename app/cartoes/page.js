"use client";

import { useEffect, useState } from "react";
import PageContainer from "../components/ui/PageContainer.jsx";
import CardHero from "../components/card/CardHero.jsx";
import CardBillTimeline from "../components/card/CardBillTimeline.jsx";
import CardInstallmentsList from "../components/card/CardInstallmentsList.jsx";
import CardSettingsForm from "../components/card/CardSettingsForm.jsx";
import { DashboardSkeleton } from "../components/Skeleton.jsx";
import { groupBillsByCycle } from "@/lib/cardPresentation";

// Fase 5.4D — CARTÃO responde "o que eu já comprometi no crédito, quanto
// pesa e quando isso alivia?" (item 10). Reconstrói /cartoes preservando
// 100% da escrita existente (PATCH /api/cards/[id]) — só a apresentação
// muda. ExternalInstallmentPlan (parcelas externas) sai desta página — dono
// agora é /compromissos (item 19, DETAIL_OWNERSHIP_MAP do relatório).
//
// `card.currentBill` (via /api/dashboard, que já usa getCardBillView —
// NUNCA recalculado aqui) é a fonte da verdade pra "qual fatura é a atual".
// /api/cards/[id]/bills devolve a janela completa (persisted + projected)
// pra montar CURRENT/NEXT/LATER — groupBillsByCycle só particiona o array
// pelo cycleMonth já resolvido, nunca re-decide qual é a atual.
export default function CartoesPage() {
  const [card, setCard] = useState(null);
  const [bills, setBills] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const dashRes = await fetch("/api/dashboard");
    const dash = await dashRes.json();
    const primaryCard = dash.cards?.[0] || null;
    setCard(primaryCard);

    if (primaryCard) {
      const [billsRes, purchasesRes] = await Promise.all([fetch(`/api/cards/${primaryCard.id}/bills`), fetch("/api/purchases")]);
      setBills(await billsRes.json());
      const allPurchases = await purchasesRes.json();
      setPurchases(allPurchases.filter((p) => p.cardId === primaryCard.id));
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function saveSettings(form) {
    await fetch(`/api/cards/${card.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        totalLimit: parseFloat(form.totalLimit),
        closingDay: form.closingDay ? parseInt(form.closingDay, 10) : null,
        dueDay: parseInt(form.dueDay, 10),
      }),
    });
    load();
  }

  if (loading || !card) {
    return <DashboardSkeleton />;
  }

  // `current` vem do MESMO array enriquecido com o known-detail-gap
  // (/api/cards/[id]/bills) — nunca de `card.currentBill` puro (esse vem de
  // /api/dashboard via getCardBillView, que não carrega os campos aditivos
  // de gap). Duas fontes pra "qual é a atual" seria uma divergência real; em
  // vez disso, `card.currentBill.cycleMonth` só serve de ANCORA pra achar a
  // linha certa dentro do mesmo array que já tem o gap calculado.
  const { current, next, later } = groupBillsByCycle(bills, card.currentBill?.cycleMonth);

  return (
    <PageContainer>
      <header className="mb-6">
        <h1 className="text-page-title text-text-primary">Cartão</h1>
        <p className="text-caption text-text-muted">{card.name} — o que já está comprometido no crédito e quando isso alivia</p>
      </header>

      <div className="space-y-4">
        <CardHero card={card} bill={current || card.currentBill} />
        <CardBillTimeline next={next} later={later} />
        <CardInstallmentsList purchases={purchases} />
      </div>

      {/* Fase 5.4D.1, item "card wall check" — CORRIGIDO: um `rounded-card`
          inteiro só pra guardar 1 linha de disclosure colapsada lia como
          "caixa vazia" (4ª caixa idêntica na pilha). Vira rodapé simples da
          página, fora do ritmo de `space-y-4` dos blocos de conteúdo. */}
      <div className="mt-6 border-t border-border-subtle pt-4">
        <CardSettingsForm card={card} onSave={saveSettings} />
      </div>
    </PageContainer>
  );
}
