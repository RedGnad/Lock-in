"use client";

import { useEffect, type ReactNode } from "react";

type ActionDialogProps = {
  open: boolean;
  title: string;
  eyebrow?: string;
  confirmLabel: string;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  children: ReactNode;
};

export function ActionDialog({
  open,
  title,
  eyebrow = "Before you continue",
  confirmLabel,
  busy = false,
  onClose,
  onConfirm,
  children,
}: ActionDialogProps) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("dialog-open");
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("dialog-open");
    };
  }, [busy, onClose, open]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => !busy && onClose()}>
      <section
        className="action-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="action-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-topline">
          <span>{eyebrow}</span>
          <button type="button" aria-label="Close" onClick={onClose} disabled={busy}>×</button>
        </div>
        <h2 id="action-dialog-title">{title}</h2>
        <div className="dialog-content">{children}</div>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="lock-button" onClick={onConfirm} disabled={busy} autoFocus>
            {busy ? "Confirming…" : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
