import type { Metadata } from "next";
import { Archivo, Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { NAV_TAGS } from "@/lib/tags";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["500", "700", "900"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? "https://pitchroots.ca"),
  title: {
    default: "PitchRoots — Canadian soccer, one feed",
    template: "%s — PitchRoots",
  },
  description:
    "What's happening in Canadian soccer today. Curated headlines from across the country — CanMNT, CanWNT, CPL, NSL, MLS, League1 and more — always linking to the source.",
  alternates: {
    types: { "application/rss+xml": "/feed.xml" },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${archivo.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="border-b-4 border-pitch">
          <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-4">
            <Link href="/" className="inline-block">
              <span className="font-display font-black text-3xl tracking-tight">
                Pitch<span className="text-pitch">Roots</span>
              </span>
            </Link>
            <p className="mt-1 text-sm text-muted">
              Canadian soccer, one feed. Every story links to its source.
            </p>
            <nav className="mt-4 flex flex-wrap gap-2 text-sm">
              {NAV_TAGS.map((t) => (
                <Link
                  key={t.slug}
                  href={`/${t.slug}`}
                  className="rounded-full border border-line px-3 py-1 font-medium hover:border-pitch hover:text-pitch transition-colors"
                >
                  {t.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{children}</main>
        <footer className="border-t border-line">
          <div className="mx-auto w-full max-w-3xl px-4 py-6 text-sm text-muted flex flex-wrap gap-x-6 gap-y-2">
            <Link href="/about" className="hover:text-pitch">About</Link>
            <a href="/feed.xml" className="hover:text-pitch">RSS</a>
            <span>Headlines and summaries link out to the original publishers.</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
