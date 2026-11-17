import type { ReactNode } from "react";
import GhostFibers from "./ghost-fibers";

/** The brand mark: a soft glass crystal, drawn in CSS (inspired by the 3D render references). */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block rotate-45 rounded-[30%] bg-gradient-to-br from-ink via-accent to-series shadow-[0_0_16px_rgb(168_197_179/0.25)]"
      style={{ width: size * 0.7, height: size * 0.7 }}
    />
  );
}

export function Brand() {
  return (
    <span className="flex items-center gap-3 text-lg font-semibold tracking-tight">
      <Logo />
      AAFM Analytics
    </span>
  );
}

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-12">
      {/* Animated WebGL backdrop (Prompt 15), in muted greens to match the theme.
          It listens on window for pointer events, so it can stay non-interactive itself. */}
      <GhostFibers
        aria-hidden
        className="!absolute inset-0 pointer-events-none"
        glowColor="#3b7a57"
        secondaryColor="#1e4634"
        lineColor="#cfe0d5"
        glow={0.6}
        brightness={0.9}
      />
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Brand />
        </div>
        <section className="glass rounded-2xl p-8">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-ink-2">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </section>
      </div>
    </main>
  );
}
