import type { NextConfig } from "next";

// The browser only ever talks to this origin. /api/* is proxied to Express, so the session
// cookie stays first-party (SameSite=Strict works, no CORS needed).
const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
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
