import { redirect } from "next/navigation";

// Fase 5.4D — rota canônica de Fluxo passa a ser /fluxo (nome curto,
// consistente com o item de nav). Redirect preservado.
export default function Page() {
  redirect("/fluxo");
}
