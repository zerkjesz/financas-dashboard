"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Fase 5.3C, item 21 — UI funcional MÍNIMA (sem redesign): formulário simples,
// estado de erro, nada de dashboard financeiro visível antes do login.
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
    <div className="max-w-sm mx-auto px-4 py-24">
      <h1 className="text-xl font-semibold tracking-tight mb-6 text-center">Entrar</h1>
      <form onSubmit={handleSubmit} className="rounded-xl border border-border bg-surface p-5 space-y-4">
        <div>
          <label htmlFor="password" className="block text-xs text-muted mb-1.5">
            Senha
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-surface-2 border border-border rounded-md px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-info"
            autoFocus
          />
        </div>
        {error && <div className="text-sm text-negative">{error}</div>}
        <button
          type="submit"
          disabled={loading || !password}
          className="w-full rounded-lg bg-positive hover:bg-positive-soft disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-slate-950 transition-colors cursor-pointer"
        >
          {loading ? "Entrando..." : "Entrar"}
        </button>
      </form>
    </div>
  );
}
