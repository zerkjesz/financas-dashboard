export default function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-white/10 bg-[#12161c] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm text-white/90 mb-4">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg bg-white/5 hover:bg-white/10 px-3 py-1.5 text-sm transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg bg-rose-600 hover:bg-rose-500 px-3 py-1.5 text-sm font-medium transition-colors"
          >
            Excluir
          </button>
        </div>
      </div>
    </div>
  );
}
