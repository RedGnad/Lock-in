"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A Lock In controlled share menu.
 *
 * The bare `navigator.share` opened the macOS system sheet on the primary click, which is wrong on
 * desktop. This offers explicit choices, X / copy / WhatsApp, and keeps the native sheet behind MORE where
 * it belongs. The link is always present as selectable text, so sharing never depends on the clipboard or
 * the share API succeeding.
 *
 * The shared text carries the Lock, the progress and the URL. It never carries a Strava activity id, an
 * athlete id, a route, or any private field: nothing here reads Strava data.
 */
export function ShareSheet({ url, text, title }: { url: string; text: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const xHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  const whatsappHref = `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // The link is shown below regardless, so a denied clipboard is not a dead end.
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }

  async function nativeShare() {
    setOpen(false);
    try {
      if (navigator.canShare?.({ title, text, url })) await navigator.share({ title, text, url });
      else await navigator.clipboard.writeText(url);
    } catch {
      // AbortError when the athlete dismisses the native sheet, or a refused clipboard. Neither is an error.
    }
  }

  const nativeAvailable = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <div className="share-control" ref={ref}>
      <button type="button" className="secondary-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        SHARE ↗
      </button>
      {open && (
        <div className="share-menu" role="menu">
          <a className="share-item" role="menuitem" href={xHref} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>POST ON X</a>
          <button type="button" className="share-item" role="menuitem" onClick={() => void copyLink()}>{copied ? "LINK COPIED ✓" : "COPY LINK"}</button>
          <a className="share-item" role="menuitem" href={whatsappHref} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>WHATSAPP</a>
          {nativeAvailable && <button type="button" className="share-item" role="menuitem" onClick={() => void nativeShare()}>MORE…</button>}
          <input className="share-link" readOnly value={url} onFocus={(event) => event.target.select()} aria-label="Invite link" />
        </div>
      )}
    </div>
  );
}
