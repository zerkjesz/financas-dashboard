"use client";

import { useState } from "react";
import Input from "../ui/Input.jsx";
import Button from "../ui/Button.jsx";
import Disclosure from "../ui/Disclosure.jsx";

// Fase 5.4D — mesma mutação PATCH /api/cards/[id] de sempre (totalLimit/
// closingDay/dueDay), só reescrita com os primitives da 5.4B em vez das
// classes ad hoc antigas. Nenhuma semântica de escrita muda (item 33).
export default function CardSettingsForm({ card, onSave }) {
  const [totalLimit, setTotalLimit] = useState(String(card.totalLimit));
  const [closingDay, setClosingDay] = useState(card.closingDay ? String(card.closingDay) : "");
  const [dueDay, setDueDay] = useState(String(card.dueDay));

  return (
    <Disclosure summary="editar limite e datas do cartão">
      <div className="mt-3 flex flex-wrap items-end gap-3 pt-1">
        <div>
          <label className="text-caption text-text-muted mb-1 block">Limite total</label>
          <Input value={totalLimit} onChange={(e) => setTotalLimit(e.target.value)} className="w-28" />
        </div>
        <div>
          <label className="text-caption text-text-muted mb-1 block">Dia de fechamento</label>
          <Input value={closingDay} onChange={(e) => setClosingDay(e.target.value)} placeholder="?" className="w-16" />
        </div>
        <div>
          <label className="text-caption text-text-muted mb-1 block">Dia de vencimento</label>
          <Input value={dueDay} onChange={(e) => setDueDay(e.target.value)} className="w-16" />
        </div>
        <Button variant="secondary" onClick={() => onSave({ totalLimit, closingDay, dueDay })}>
          Salvar
        </Button>
      </div>
    </Disclosure>
  );
}
