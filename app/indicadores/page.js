import { redirect } from "next/navigation";

// Fase 5.4F.1 — INDICADORES_REDIRECT_FINAL_DECISION: alvo trocado de
// /metas pra / (Home). A Fase 5.4F removeu o conteúdo real de Indicadores
// (IndicadoresView.jsx, lib/indicators.js — vocabulário V1), então
// redirecionar pra /metas hoje levaria um bookmark antigo a uma página que
// não tem mais NADA do que ele esperava ver (só Goals, um assunto
// diferente). Auditoria semântica do conteúdo antigo (8 stats + 1 gráfico):
// as duas métricas mais proeminentes ("% do salário comprometido", "Caixa
// livre") já têm equivalente canônico direto na Home (NextIncomeCard 44%,
// FinancialHero "Dinheiro livre"); o resto se distribui entre Compromissos
// (totais de contas/parcelas futuras), Histórico (despesas fixas/
// variáveis) e Fluxo (comprometimento dos próximos meses). Sem um dono
// único claro no restante, Home é o ponto de reorientação mais honesto —
// é de onde o produto inteiro é navegável, não uma tentativa de recriar o
// painel antigo.
export default function Page() {
  redirect("/");
}
