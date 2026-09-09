import MetasView from "./MetasView.jsx";
import PageContainer from "../components/ui/PageContainer.jsx";

// Fase 5.4F — METAS_FINAL_DECISION: IndicadoresView removida desta página.
// Ela mostrava "Patrimônio disponível" (soma de todas as contas, incluindo
// VA) e "Caixa livre" (unrestrictedCash) lado a lado — exatamente o
// vocabulário V1 que o resto do produto já eliminou (Home usa "Dinheiro
// livre" = freeMoney, um número conceitualmente diferente e frequentemente
// de SINAL diferente do "Caixa livre" mostrado aqui). Zero valor não-
// duplicado: "% do salário comprometido" já existe em Home/Fluxo via
// nextIncomeCommitment canônico; "comprometimento dos próximos meses" é uma
// soma paralela (Bill+CardBill por mês) que não passa pelos helpers
// canônicos. DEPRECATE, não MIGRATE — ver METAS_FINAL_DECISION completo no
// relatório da fase. Goals (MetasView) preservado: função própria (metas de
// poupança), sem equivalente em nenhuma outra página, não usa nenhum helper
// V1.
export default function Page() {
  return (
    <PageContainer spaced>
      <MetasView />
    </PageContainer>
  );
}
