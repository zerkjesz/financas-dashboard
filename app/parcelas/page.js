import { redirect } from "next/navigation";

// Fase 5.4D, item 19 — ExternalInstallmentPlan (parcelas externas) muda de
// dono: era exibido dentro de /cartoes (junto com Purchase/Installment do
// próprio cartão), agora vive em /compromissos (o runoff responde "quando
// isso alivia", que é uma pergunta de Compromissos, não de Cartão — ver
// DETAIL_OWNERSHIP_MAP do relatório da fase). Redirect atualizado, mesma
// disciplina de nunca deixar um link antigo morto.
export default function Page() {
  redirect("/compromissos");
}
