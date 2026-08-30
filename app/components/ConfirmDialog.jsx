export default function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-border-strong bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm text-slate-200 mb-4">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg bg-surface-2 hover:bg-border px-3 py-1.5 text-sm text-slate-200 transition-colors cursor-pointer"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg bg-negative hover:bg-red-400 px-3 py-1.5 text-sm font-medium text-slate-950 transition-colors cursor-pointer"
          >
            Excluir
          </button>
        </div>
      </div>
    </div>
  );
}
