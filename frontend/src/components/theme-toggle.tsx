"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { cx } from "@/components/ui";

// Light mode (Prompt 70): System (default), Light or Dark, saved per browser. The root layout's
// script applies it before the first paint; this keeps it applied and follows the system's
// setting live while "System" is chosen.
type Choice = "system" | "light" | "dark";
const OPTIONS: { value: Choice; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "Match system", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

const read = (): Choice => {
  try {
    const saved = localStorage.getItem("theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
};

// The saved choice as a tiny external store, so every toggle (sidebar and mobile bar) agrees.
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const save = (choice: Choice) => {
  try {
    if (choice === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", choice);
  } catch {
    // storage blocked: nothing to remember it by
  }
  listeners.forEach((fn) => fn());
};

export function ThemeToggle() {
  // null on the server (it can't read the choice); the page itself is already themed.
  const choice = useSyncExternalStore(subscribe, read, () => null);

  useEffect(() => {
    if (!choice) return;
    const system = matchMedia("(prefers-color-scheme: light)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "light",
        choice === "light" || (choice === "system" && system.matches)
      );
    apply();
    if (choice !== "system") return;
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [choice]);

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex rounded-xl border border-line bg-black/20 p-1"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={choice === value}
          aria-label={label}
          title={label}
          onClick={() => save(value)}
          className={cx(
            "grid flex-1 place-items-center rounded-lg py-1.5 transition",
            choice === value ? "bg-ink text-black" : "text-ink-3 hover:text-ink"
          )}
        >
          <Icon size={15} />
        </button>
      ))}
    </div>
  );
}
