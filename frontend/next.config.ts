import type { NextConfig } from "next";

// The browser only ever talks to this origin. /api/* is proxied to Express, so the session
// cookie stays first-party (SameSite=Strict works, no CORS needed).
const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8000";

// E21 (docs/edge-case-audit.md): Content-Security-Policy as defense in depth against XSS.
// Next.js's "Without Nonces" form (frontend/node_modules/next/dist/docs/01-app/02-guides/
// content-security-policy.md): nonces need every page dynamically rendered and are
// incompatible with Partial Prerendering. Scripts and
// styles stay same-origin; the only other connection allowed is the dev socket URL (in
// production the socket is same-origin through Nginx). Fonts are self-hosted by next/font.
const isDev = process.env.NODE_ENV === "development";
// Same rule as src/lib/realtime.ts: the direct socket URL exists only in development.
const socketUrl = isDev ? process.env.NEXT_PUBLIC_SOCKET_URL : undefined;
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  `connect-src 'self'${socketUrl ? ` ${socketUrl} ${socketUrl.replace(/^http/, "ws")}` : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // No upgrade-insecure-requests: it would break a local production run over plain HTTP.
  // HTTPS is enforced by HSTS at Nginx in the deployment.
].join("; ");

const nextConfig: NextConfig = {
  // Served as-is on Cloudflare Workers: the only next/image is the hero banner, not worth a
  // billed Cloudflare Images binding.
  images: { unoptimized: true },
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=()",
        },
      ],
    },
  ],
  // No cacheComponents / partialPrefetching (Prompt 57): on Cloudflare Workers, Next.js
  // "cannot guarantee that Cache Components will run as expected" (the runtime's setTimeout),
  // and the Worker hung on every page with it on. Every signed-in page renders in the browser
  // behind the session check anyway, so the app gains nothing from it. Off everywhere, so
  // development and production behave the same.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  rewrites: async () => [
    { source: "/api/:path*", destination: `${backendUrl}/api/:path*` },
    // Real-time fallback when NEXT_PUBLIC_SOCKET_URL is unset (Socket.IO long-polling).
    { source: "/socket.io", destination: `${backendUrl}/socket.io` },
  ],
};

export default nextConfig;
