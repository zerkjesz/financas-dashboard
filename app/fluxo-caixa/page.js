import { redirect } from "next/navigation";

// Fase 5.4D — rota canônica de Fluxo passou a ser /fluxo (nome curto,
// consistente com o item de nav). Fase 6.0 (Design Freeze) — renomeada de
// novo pra /projecao (nome final do design aprovado). Redirect preservado
// em cascata — nenhum link/bookmark antigo quebra.
export default function Page() {
  redirect("/projecao");
}
