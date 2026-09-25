import { NextResponse } from "next/server";
import { performUndo } from "@/lib/compromissosActions";
import { domainErrorStatus } from "@/lib/domainErrors";

export const dynamic = "force-dynamic";
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corpo inválido." }, { status: 400 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await performUndo(body)) });
  } catch (err) {
    const status = domainErrorStatus(err);
    if (status) return NextResponse.json({ ok: false, code: err.code, error: err.message }, { status });
    console.error("[api/compromissos/undo] erro:", err.message);
    return NextResponse.json({ ok: false, error: "Não consegui desfazer. Nada foi alterado." }, { status: 500 });
  }
}
