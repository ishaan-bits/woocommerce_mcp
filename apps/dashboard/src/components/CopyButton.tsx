/**
 * Copy-to-clipboard button with a manual fallback (some browsers / non-secure
 * contexts lack navigator.clipboard). Shows transient "Copied" feedback.
 */

import { useCallback, useEffect, useRef, useState } from "react";

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label = "Copy",
  className = "btn btn-secondary btn-sm",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const onClick = useCallback(() => {
    void copyText(value).then((ok) => {
      setState(ok ? "copied" : "failed");
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 2000);
    });
  }, [value]);

  return (
    <button type="button" className={className} onClick={onClick} aria-live="polite">
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}

/** A read-only code block with a copy affordance — used by Settings. */
export function CopyableCode({ value, label }: { value: string; label?: string }) {
  return (
    <div className="code-block">
      <div className="code-block-head">
        {label !== undefined && <span className="muted small">{label}</span>}
        <CopyButton value={value} />
      </div>
      <pre>
        <code>{value}</code>
      </pre>
    </div>
  );
}
