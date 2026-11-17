"use client";

import { ChevronDown, X } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useRef } from "react";

const cx = (...classes: (string | false | null | undefined)[]) =>
  classes.filter(Boolean).join(" ");

const BUTTON = {
  primary:
    "bg-ink text-black font-semibold shadow-[0_8px_24px_-12px_rgb(255_255_255/0.35)] hover:bg-white",
  ghost: "glass text-ink hover:bg-glass-strong",
  danger: "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
};

export function Button({
  variant = "primary",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: keyof typeof BUTTON }) {
  return (
    <button
      className={cx(
        "inline-flex h-10 items-center justify-center gap-2 rounded-xl px-5 text-sm transition disabled:cursor-not-allowed disabled:opacity-50",
        BUTTON[variant],
        className
      )}
      {...props}
    />
  );
}

// Colours live here, chosen by `tone`, never passed via className: Tailwind resolves
// conflicting utilities by stylesheet order, not class order, so an override like
// `text-black/60` on top of `text-ink-2` silently lost (Prompt 29).
const ICON_TONE = {
  default: "text-ink-2 hover:bg-glass-strong hover:text-ink",
  danger: "text-ink-2 hover:bg-danger/15 hover:text-danger",
  // for icons sitting on a light (selected) pill
  light: "text-black/70 hover:bg-black/10 hover:text-black",
  lightDanger: "text-black/70 hover:bg-black/10 hover:text-red-700",
};

export function IconButton({
  label,
  tone = "default",
  className,
  ...props
}: ComponentProps<"button"> & {
  label: string;
  tone?: keyof typeof ICON_TONE;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        "grid size-9 place-items-center rounded-lg transition",
        ICON_TONE[tone],
        className
      )}
      {...props}
    />
  );
}

const FIELD =
  "h-11 w-full rounded-xl border border-line bg-black/30 px-4 text-sm text-ink placeholder:text-ink-3 outline-none transition focus:border-accent/60";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

export const Input = ({ className, ...props }: ComponentProps<"input">) => (
  <input className={cx(FIELD, className)} {...props} />
);

/**
 * `appearance-none` removes the browser's own arrow, so a chevron is drawn here (Prompt 31).
 * Sizing goes on the wrapper via `className` (default: full width, 44px tall); it replaces
 * the default instead of competing with it, avoiding Tailwind class conflicts.
 */
export const Select = ({ className, ...props }: ComponentProps<"select">) => (
  <span className={cx("relative block", className ?? "h-11 w-full")}>
    <select
      className="h-full w-full cursor-pointer appearance-none rounded-xl border border-line bg-black/40 pr-10 pl-4 text-sm text-ink outline-none transition focus:border-accent/60 [&_option]:bg-canvas"
      {...props}
    />
    <ChevronDown
      aria-hidden
      size={16}
      className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-ink-2"
    />
  </span>
);

export const Card = ({ className, ...props }: ComponentProps<"section">) => (
  <section className={cx("glass rounded-2xl", className)} {...props} />
);

export const Badge = ({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent";
}) => (
  <span
    className={cx(
      "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs",
      tone === "accent"
        ? "bg-accent/15 text-accent"
        : "bg-glass-strong text-ink-2"
    )}
  >
    {children}
  </span>
);

export function Notice({
  tone = "error",
  children,
}: {
  tone?: "error" | "success" | "info";
  children: ReactNode;
}) {
  if (!children) return null;
  const tones = {
    error: "border-danger/30 bg-danger/10 text-danger",
    success: "border-accent/30 bg-accent/10 text-accent",
    info: "border-line bg-glass text-ink-2",
  };
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cx("rounded-xl border px-4 py-3 text-sm", tones[tone])}
    >
      {children}
    </p>
  );
}

/** Native <dialog>: focus trap, Esc to close and inert background come from the browser. */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="glass m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl bg-canvas/90 p-0 text-ink backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <div className="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 className="text-base font-semibold">{title}</h2>
        <IconButton label="Close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="p-6">{open && children}</div>
    </dialog>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 text-sm text-ink-3">
      <span className="size-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
      {label}…
    </div>
  );
}

export { cx };
