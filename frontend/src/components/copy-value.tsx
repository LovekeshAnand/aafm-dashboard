"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cx, Notice } from "@/components/ui";

/**
 * A secret shown once (one-time passwords, webhook signing secrets) with an animated copy
 * button (Prompt 30). `label` names the value for screen readers ("password", "secret").
 */
export function CopyValue({ value, label }: { value: string; label: string }) {
  // count > 0 = just copied; bumping it re-keys the icon so the animation replays per click.
  const [copies, setCopies] = useState(0);
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const copy = async () => {
    window.clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(value);
      setCopies((n) => n + 1);
      setState("copied");
    } catch {
      setState("failed"); // e.g. clipboard permission denied: the text is still select-all
    }
    resetTimer.current = window.setTimeout(() => setState("idle"), 2000);
  };

  return (
    <>
      <div className="flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/5 px-4 py-3 font-mono text-lg tracking-wide">
        <span className="min-w-0 flex-1 break-all select-all">{value}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}`}
          className={cx(
            "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 font-sans text-xs font-semibold transition-colors duration-300",
            state === "copied"
              ? "animate-copy-ring bg-accent text-black"
              : "bg-white/10 text-ink hover:bg-white/15"
          )}
        >
          {state === "copied" ? (
            <Check key={copies} size={15} className="animate-copy-pop" />
          ) : (
            <Copy size={15} />
          )}
          {state === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      {/* Announced to screen readers; the visible change is the button itself. */}
      <p role="status" className="sr-only">
        {state === "copied" ? `${label} copied to clipboard` : ""}
      </p>
      {state === "failed" && (
        <Notice>
          Couldn&apos;t access the clipboard. Select the {label} and copy it
          manually.
        </Notice>
      )}
    </>
  );
}
