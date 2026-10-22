/**
 * Confirmation dialog for destructive/high-impact admin actions. Wraps Modal
 * with an explicit impact explanation and cancel/confirm buttons. ESC and
 * backdrop click cancel (safe default — never the destructive action).
 */

import type { ReactNode } from "react";
import { Modal } from "./Modal.tsx";

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      dismissable={busy !== true}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy === true}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger === true ? "btn btn-danger" : "btn btn-primary"}
            onClick={onConfirm}
            disabled={busy === true}
          >
            {busy === true ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="stack">{message}</div>
    </Modal>
  );
}
