/**
 * Presentational atoms shared by every page: badges, banners, skeletons,
 * empty states. No logic beyond tone mapping — state transitions live in
 * the pure libs (testable) and the pages.
 */

import type { ReactNode } from "react";

export type Tone = "neutral" | "muted" | "success" | "warn" | "error" | "info" | "admin" | "member";

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Banner({
  tone = "info",
  role = "status",
  children,
}: {
  tone?: "info" | "warn" | "error" | "ok";
  role?: "status" | "alert" | "note";
  children: ReactNode;
}) {
  return (
    <p className={`banner banner-${tone}`} role={role}>
      {children}
    </p>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner banner-error" role="alert">
      <p>{message}</p>
      {onRetry !== undefined && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {hint !== undefined && <p className="muted">{hint}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-group" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      {label !== undefined && <span className="muted small">{label}</span>}
    </span>
  );
}

/** A labelled form field wrapper (label always present, required marker). */
export function Field({
  id,
  label,
  required,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required === true && <span aria-hidden="true"> *</span>}
      </label>
      {children}
      {hint !== undefined && (
        <p className="muted small" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error !== null && error !== undefined && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
