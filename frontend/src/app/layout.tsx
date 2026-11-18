import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AAFM Dashboard",
  description: "Multi-tenant analytics dashboard with real-time collaboration",
};

// Light mode (Prompt 70): apply the saved choice (or the system's) before the first paint, so
// the page never flashes the wrong theme. ThemeToggle changes it later. Keep in sync with it.
const THEME_SCRIPT = `try{var t=localStorage.getItem("theme");document.documentElement.classList.toggle("light",t?t==="light":matchMedia("(prefers-color-scheme: light)").matches)}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // The theme script sets a class before React hydrates.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
