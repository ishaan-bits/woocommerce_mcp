/**
 * Tiny inline toast system: a fixed live-region host plus a hook that auto-
 * dismisses after a timeout (cleaned up on unmount — no leaked timers).
 * Toasts carry short success/error confirmations only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { makeToast, pushToast, removeToast, type Toast, type ToastTone } from "../state.ts";

const TOAST_TTL_MS = 4000;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) clearTimeout(timer);
      active.clear();
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => removeToast(current, id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const toast = makeToast(tone, message);
      setToasts((current) => pushToast(current, toast));
      const timer = setTimeout(() => dismiss(toast.id), TOAST_TTL_MS);
      timers.current.set(toast.id, timer);
    },
    [dismiss],
  );

  /** Drop every visible toast and cancel their timers (login/logout transitions). */
  const clear = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    setToasts([]);
  }, []);

  return { toasts, push, dismiss, clear };
}

export function Toasts({ toasts, onDismiss }: { toasts: readonly Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
          <span className="toast-message">{toast.message}</span>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
