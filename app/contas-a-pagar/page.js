import { redirect } from "next/navigation";

// Fase 5.4D — "Contas & Fluxo" se divide em duas tarefas reais: Compromissos
// (CRUD de Bill + visão de obrigações, esta rota) e Fluxo (só projeção,
// /fluxo). Redirect preservado — nenhum link/bookmark antigo quebra.
export default function Page() {
  redirect("/compromissos");
}
