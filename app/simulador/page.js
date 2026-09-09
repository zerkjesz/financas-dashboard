import { Suspense } from "react";
import PageContainer from "../components/ui/PageContainer.jsx";
import SimuladorClient from "../components/simulator/SimuladorClient.jsx";
import { DashboardSkeleton } from "../components/Skeleton.jsx";

// Fase 5.4E — Simulador reconstruído (SimuladorView.jsx antigo preservado,
// não mais importado — mesmo padrão de preservação de V1 usado em todo o
// projeto). `Suspense` é exigido pelo Next.js porque SimuladorClient usa
// useSearchParams (prefill contextual via query params, item 14/46) — sem
// isso o build falha ("useSearchParams should be wrapped in a suspense
// boundary"), não é uma escolha de UX.
export default function Page() {
  return (
    <PageContainer maxWidth="6xl">
      <Suspense fallback={<DashboardSkeleton />}>
        <SimuladorClient />
      </Suspense>
    </PageContainer>
  );
}
