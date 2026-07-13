import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Toolbar } from "wildwood/nextjs/kit";
import { wildwood } from "@/lib/wildwood";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "wildwood — manual",
  description: "Git as content store. Typeset as man page.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // `wildwood` is `any` — avoid `never`/type inference issues from optional config.
  const navRes = (await wildwood.nav.findMany({ with: { children: true } })) as {
    items?: Array<{ label?: string; children?: Array<{ slug?: string; title?: string; _meta?: { path?: string } }> }>;
  };
  const nav = navRes?.items?.[0] as { label?: string; children?: Array<{ slug: string; title: string; _meta: { path: string } }> } | undefined;
  if (!nav) {
    return null;
  }
  const docs = (nav.children ?? []) as Array<{ slug: string; title: string; _meta: { path: string } }>;

  return (
    // suppressHydrationWarning — color-scheme is driven by prefers-color-scheme,
    // no FOUC toggle. If we add manual theme switching later, inject the
    // before-paint script here. For now system-only, so pure CSS.
    <html
      lang="en"
      className={`${geistMono.variable} antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-screen">
        {/* top rule — man header */}
        <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="mx-auto flex h-[2.75rem] w-full max-w-[112ch] items-center justify-between gap-6 px-6 tabular-nums">
            <div className="flex items-center gap-8">
              <Link
                href="/"
                className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] underline decoration-border underline-offset-4 hover:decoration-foreground"
              >
                wildwood(1)
              </Link>
              <span className="hidden font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground md:inline">
                git as cms · typed · versioned · branchable
              </span>
            </div>
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              MANUAL
            </span>
          </div>
        </header>

        <div className="mx-auto grid w-full max-w-[112ch] grid-cols-1 gap-0 px-6 md:grid-cols-[18rem_1fr]">
          {/* sidebar — SYNOPSIS style index */}
          <aside className="border-border py-10 pr-8 max-md:border-b md:sticky md:top-[2.75rem] md:h-[calc(100svh-2.75rem)] md:overflow-auto md:border-r">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              {nav?.label ?? "INDEX"}
            </div>

            <nav className="mt-6 space-y-[0.65rem] font-mono text-[12.5px] leading-[1.9]">
              {docs.map((doc, i) => (
                <div key={doc._meta.path} className="flex gap-3">
                  <span className="w-5 shrink-0 tabular-nums text-muted-foreground/70">
                    {(i + 1).toString().padStart(2, "0")}
                  </span>
                  <Link
                    href={`/docs/${doc.slug}`}
                    className="underline decoration-border underline-offset-[0.28em] decoration-[0.5px] hover:decoration-foreground"
                  >
                    {doc.title.toLowerCase()}
                  </Link>
                </div>
              ))}
            </nav>

            <div className="mt-12 border-t border-border pt-8 font-mono text-[11px] leading-[1.9] text-muted-foreground">
              <div className="uppercase tracking-[0.12em]">source</div>
              <div className="mt-2 normal-case tracking-[-01em]">
                <code className="rounded border border-border bg-card px-1 py-0.5 text-[11px]">content/</code>{" "}
                in this repo.
                <br />
                queries via <code className="text-foreground">wildwood.docs.findMany()</code>.
              </div>
              <div className="mt-5 uppercase tracking-[0.12em]">see also</div>
              <div className="mt-2 space-y-1">
                <Link className="block underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/intro">
                  wildwood(1) intro
                </Link>
                <Link className="block underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/api">
                  wildwood(5) api
                </Link>
                <Link className="block underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/guides">
                  wildwood(7) guides
                </Link>
              </div>
            </div>
          </aside>

          {/* main — whitespace-first, measure constrained */}
          <main className="min-w-0 py-10 pl-0 md:pl-10">
            <div className="max-w-[var(--content-measure)]">{children}</div>
          </main>
        </div>

        {/* Toolbar is opt-out of typeset; deduce theme from system via CSS */}
        <div className="not-typeset">
          <Toolbar wildwood={wildwood} apiBase="/api" />
        </div>
      </body>
    </html>
  );
}
