"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * A brief, celebratory confirmation shown at the real win moments (a verified run, a target met, an XP goal
 * reached). It is feedback only: nothing on chain depends on it. It auto-dismisses, closes on click or
 * Escape, and drops its motion under prefers-reduced-motion.
 */
export function SuccessOverlay({ title, detail, onClose }: { title: string; detail?: string; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 2_800);
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="success-overlay" role="status" aria-live="assertive" onClick={onClose}>
      <div className="success-burst" onClick={(event) => event.stopPropagation()}>
        <span className="success-mark" aria-hidden="true">✓</span>
        <strong>{title}</strong>
        {detail && <p>{detail}</p>}
        <button type="button" className="success-dismiss" onClick={onClose}>DONE</button>
      </div>
    </div>,
    document.body,
  );
}
