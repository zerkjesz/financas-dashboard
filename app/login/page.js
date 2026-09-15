"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Input from "../components/ui/Input.jsx";
import Button from "../components/ui/Button.jsx";

// Fase 5.3C, item 21 — UI funcional MÍNIMA: formulário simples, estado de
// erro, nada de dashboard financeiro visível antes do login.
//
// Fase 6.0 (restyle) — visual trocado pro layout de 2 colunas do design
// aprovado (painel de marca escuro + coluna de formulário clara). Contrato
// de auth 100% preservado: mesmo POST /api/auth/login, mesmo shape de
// request/response, mesmo tratamento de 429/erro de credencial/erro de
// rede — só a apresentação muda (ver app/api/auth/login/route.js, não
// tocado).
//
// Mobile: o mock aprovado é desktop-only 2-col; como o Norte não tem um
// modo "fake-phone-frame", a decisão aqui foi ESCONDER o painel decorativo
// abaixo de `md` e mostrar só a coluna de formulário em largura cheia —
// mais limpo que empilhar um painel de marca inteiro acima do form num
// celular (a alternativa permitida pelo brief).
export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.push("/");
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) setError("Muitas tentativas — espere um pouco antes de tentar de novo.");
      else setError("Senha incorreta.");
      void data;
    } catch {
      setError("Erro ao conectar. Tenta de novo.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      {/* Painel de marca — escondido abaixo de md, ver nota acima. */}
      <div className="hidden md:flex md:min-h-screen flex-col justify-between bg-ink text-white p-10 lg:p-14">
        <div className="flex items-center gap-2.5">
          {/* Mesmo tratamento do mark da sidebar (app/components/NavBar.jsx):
              quadrado ink + notch lime rotacionado 45°. Como o painel já é
              ink, o quadrado ganha um fundo branco/10 (em vez de bg-ink puro)
              só pra ter contorno visível contra o próprio fundo — versão
              "maior/decorativa" do mesmo mark, não um mark novo. */}
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10" aria-hidden="true">
            <span className="h-2.5 w-2.5 rotate-45 bg-accent" />
          </span>
          <span className="text-[1.1875rem] font-semibold tracking-tight text-white">Norte</span>
        </div>

        <div className="max-w-[420px]">
          <h2 className="text-4xl lg:text-[2.75rem] leading-[1.05] font-semibold tracking-tight mb-5">
            Quanto dá para gastar hoje, sem susto no fim do mês.
          </h2>
          <p className="text-base leading-relaxed text-white/70">
            Uma resposta só, na primeira tela. O resto fica guardado para quando você quiser olhar.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <span className="h-px w-[22px] bg-accent" aria-hidden="true" />
          <span className="text-eyebrow text-white/60">Suas contas em um lugar</span>
        </div>
      </div>

      {/* Coluna de formulário — real, wiring intocado. */}
      <div className="flex min-h-screen items-center justify-center bg-bg px-6 py-16">
        <div className="w-full max-w-[360px] mx-auto">
          <h1 className="text-[1.75rem] font-semibold tracking-tight text-text-primary mb-6">Entrar</h1>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="password" className="text-eyebrow text-text-muted mb-1.5 block">
                Senha
              </label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                className="!bg-surface shadow-card"
              />
            </div>
            {/* Mesmas condições de exibição de sempre (senha errada / 429 /
                erro de rede) — só o container visual muda pra bater com a
                família ocre de warning do design system (nunca vermelho). */}
            {error && (
              <div role="alert" className="rounded-control bg-warning-bg px-3 py-2 text-sm text-warning-text">
                {error}
              </div>
            )}
            <Button type="submit" disabled={loading || !password} loading={loading} className="w-full">
              {loading ? "Entrando..." : "Entrar"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
