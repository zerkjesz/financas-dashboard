"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Card from "../components/ui/Card.jsx";
import Input from "../components/ui/Input.jsx";
import Button from "../components/ui/Button.jsx";

// Fase 5.3C, item 21 — UI funcional MÍNIMA (sem redesign): formulário simples,
// estado de erro, nada de dashboard financeiro visível antes do login.
// Fase 5.4B, item 31 — recebe os primitives da fundação (Card/Input/Button)
// pra não parecer outro produto do resto do app — sem virar marketing page.
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
      <h1 className="text-page-title text-center mb-6 text-text-primary">Entrar</h1>
      <Card>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="password" className="text-label text-text-muted mb-1.5 block">
              Senha
            </label>
            <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </div>
          {error && (
            <div role="alert" className="text-sm text-danger">
              {error}
            </div>
          )}
          <Button type="submit" disabled={loading || !password} loading={loading} className="w-full">
            {loading ? "Entrando..." : "Entrar"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
