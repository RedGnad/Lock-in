"use client";

import { useEffect, useRef, type ReactNode } from "react";

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
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("dialog-open");
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("dialog-open");
      previousFocus?.focus();
    };
  }, [busy, onClose, open]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => !busy && onClose()}>
      <section
        ref={dialog}
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
