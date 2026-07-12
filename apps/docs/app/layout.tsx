import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toolbar } from "tr33/nextjs/kit";
import { tr33 } from "@/lib/tr33";
import type { NavItem } from "@/lib/content";
import "./globals.css";
import Link from "next/link";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tr33 Docs",
  description: "Documentation powered by the public Tr33 API.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Layout owns nav: single `nav.findMany({ with: { children } })` — no franken-index helper.
  const navRes = (await tr33.nav.findMany({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    with: { children: true } as any,
  })) as unknown as { items: NavItem[] };
  const nav = navRes.items[0] ?? null;

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} antialiased`}
    >
      <body>
        <div className="mx-auto flex min-h-screen w-full max-w-6xl gap-10 px-6 py-10">
          <aside className="hidden w-64 shrink-0 border-r border-[color:var(--border)] pr-8 lg:block">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              Tr33 Docs
            </Link>
            <p className="mt-3 text-sm font-medium uppercase tracking-[0.2em] text-[color:var(--muted)]">
              {nav?.label ?? "Documentation"}
            </p>
            <nav className="mt-6 space-y-2">
              {(nav?.children ?? []).map((doc) => (
                <Link
                  key={doc._meta.path}
                  href={`/docs/${doc.slug}`}
                  className="block rounded-xl px-3 py-2 text-sm text-[color:var(--muted)] hover:bg-white hover:text-foreground"
                >
                  {doc.title}
                </Link>
              ))}
            </nav>
          </aside>
          <div className="min-w-0 flex-1">{children}</div>
        </div>
        <Toolbar tr33={tr33} apiBase="/api" theme="light" />
      </body>
    </html>
  );
}
