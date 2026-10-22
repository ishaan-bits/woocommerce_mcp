/**
 * Accessible modal dialog: backdrop, ESC-to-close (optional), focus trap on
 * open, restores focus on unmount. No portal library — a fixed-position
 * element with role="dialog" + aria-modal is enough and dependency-free.
 */

import { useCallback, useEffect, useRef, type ReactNode } from "react";

export function Modal({
  title,
  children,
  footer,
  onClose,
  dismissable = true,
  labelledBy,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  /** false = requires an explicit action (e.g. one-time key modal). */
  dismissable?: boolean;
  labelledBy?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const panel = panelRef.current;
    panel?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, []);

  useEffect(() => {
    if (!dismissable) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismissable, onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (dismissable && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? "modal-title"}
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2 id={labelledBy ?? "modal-title"}>{title}</h2>
          {dismissable && (
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Close dialog" onClick={onClose}>
              ×
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer !== undefined && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
