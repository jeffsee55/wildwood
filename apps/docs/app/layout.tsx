import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import Link from "next/link";
import { cacheLife, cacheTag } from "next/cache";
import { Suspense } from "react";
import { Toolbar } from "wildwood/nextjs/kit";
import { WILDWOOD_CONTENT_TAG, getContext, wildwood } from "@/lib/wildwood";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "wildwood — manual",
  description: "Git as content store. Typeset as man page.",
};

async function getNav(opts: { branch: string; isDraft: boolean }) {
  "use cache";
  cacheLife("hours");
  cacheTag(WILDWOOD_CONTENT_TAG, `wildwood:branch:${opts.branch}`);

  const res = await wildwood.nav.findMany({ ref: opts.branch, with: { children: true } });
  return res.items[0] ?? null;
}

// RootLayout stays static; all dynamic work (cookies/draftMode via getContext)
// lives inside Suspense so cacheComponents can prerender the shell.
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistMono.variable} antialiased`} suppressHydrationWarning>
      <body className="min-h-screen">
        <Suspense fallback={<FallbackShell />}>
          <DynamicShell>{children}</DynamicShell>
        </Suspense>

        {/* Toolbar reads cookies (dynamic) → must be inside Suspense. */}
        <div className="not-typeset">
          <Suspense fallback={null}>
            <Toolbar wildwood={wildwood} apiBase="/api" />
          </Suspense>
        </div>
      </body>
    </html>
  );
}

function FallbackShell() {
  return (
    <>
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80">
        <div className="mx-auto flex h-11 w-full max-w-[112ch] items-center justify-between gap-6 px-6 tabular-nums">
          <div className="flex items-center gap-8">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em]">
              (ww)
            </span>
          </div>
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            MANUAL
          </span>
        </div>
      </header>
      <div className="mx-auto grid w-full max-w-[112ch] grid-cols-1 gap-0 px-6 md:grid-cols-[18rem_1fr]">
        <aside className="border-border py-10 pr-8 max-md:border-b md:sticky md:top-11 md:h-[calc(100svh-2.75rem)] md:overflow-auto md:border-r">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            INDEX
          </div>
          <div className="mt-6 h-32 animate-pulse rounded bg-muted/30" />
        </aside>
        <main className="min-w-0 py-10 pl-0 md:pl-10">
          <div className="max-w-(--content-measure) h-40 animate-pulse rounded bg-muted/20" />
        </main>
      </div>
    </>
  );
}

async function DynamicShell({ children }: { children: React.ReactNode }) {
  const { branch, isDraft } = await getContext();
  const nav = await getNav({ branch, isDraft });

  if (!nav) {
    return (
      <>
        <div className="mx-auto max-w-[112ch] px-6 py-10 font-mono text-[12px]">
          no nav found — <code>content/nav/index.json</code> missing.
        </div>
        <main className="min-w-0 py-10">
          <div className="mx-auto max-w-[112ch] px-6">
            <div className="max-w-(--content-measure)">{children}</div>
          </div>
        </main>
      </>
    );
  }

  type NavDoc = { _meta: { path: string }; slug: string; title: string };
  const docs = (nav.children ?? []) as NavDoc[];

  return (
    <>
      {/* top rule — man header */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80">
        <div className="mx-auto flex h-11 w-full max-w-[112ch] items-center justify-between gap-6 px-6 tabular-nums">
          <div className="flex items-center gap-8">
            <Link
              href="/"
              className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] underline decoration-border underline-offset-4 hover:decoration-foreground"
            >
              {`(ww)`}
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
        <aside className="border-border py-10 pr-8 max-md:border-b md:sticky md:top-11 md:h-[calc(100svh-2.75rem)] md:overflow-auto md:border-r">
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
            <div className="mt-2 normal-case tracking-[-0.01em]">
              <code className="rounded border border-border bg-card px-1 py-0.5 text-[11px]">
                content/
              </code>{" "}
              in this repo.
              <br />
              queries via <code className="text-foreground">wildwood.docs.findMany()</code>.
            </div>
            <div className="mt-5 uppercase tracking-[0.12em]">see also</div>
            <div className="mt-2 space-y-1">
              <Link
                className="block underline decoration-border underline-offset-4 hover:decoration-foreground"
                href="/docs/intro"
              >
                wildwood(1) intro
              </Link>
              <Link
                className="block underline decoration-border underline-offset-4 hover:decoration-foreground"
                href="/docs/api"
              >
                wildwood(5) api
              </Link>
              <Link
                className="block underline decoration-border underline-offset-4 hover:decoration-foreground"
                href="/docs/guides"
              >
                wildwood(7) guides
              </Link>
            </div>
          </div>
        </aside>

        {/* main — whitespace-first, measure constrained */}
        <main className="min-w-0 py-10 pl-0 md:pl-10">
          <div className="max-w-(--content-measure)">{children}</div>
        </main>
      </div>
    </>
  );
}
