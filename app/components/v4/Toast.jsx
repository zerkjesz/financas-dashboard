"use client";
import { Ico } from "./Icons.jsx";

export default function Toast({ toast, onUndo }) {
  if (!toast) return null;
  return (
    <div className="n4-layer">
      <div className="n4-toast" role="status" aria-live="polite">
        {toast.undo && (
          <div className="n4-check" style={{ width: 22, height: 22 }}>
            <Ico name="check" size={12} stroke="#0b0b0c" width={2.8} />
          </div>
        )}
        <span style={{ fontSize: 14, flex: 1 }}>{toast.msg}</span>
        {toast.undo && <button type="button" onClick={onUndo}>Desfazer</button>}
      </div>
    </div>
  );
}
