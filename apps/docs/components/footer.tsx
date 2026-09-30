import Link from "next/link";

export function Footer() {
  // Use a static year to avoid prerender issues
  // Update manually each year or make this a client component if dynamic is needed
  const currentYear = 2025;

  return (
    <footer className="border-t border-border bg-background/95 backdrop-blur">
      <div className="mx-auto max-w-[112ch] px-6 py-8">
        <div className="grid gap-8 md:grid-cols-3">
          {/* Project Info */}
          <div>
            <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em]">
              wildwood
            </div>
            <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
              Git as CMS. Typed, versioned, branchable content for modern web applications.
            </p>
          </div>

          {/* Documentation Links */}
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Documentation
            </div>
            <nav className="mt-3 space-y-2">
              <Link
                href="/docs/intro"
                className="block font-mono text-[11px] underline decoration-border underline-offset-4 hover:decoration-foreground"
              >
                Introduction
              </Link>
              <Link
                href="/docs/api"
                className="block font-mono text-[11px] underline decoration-border underline-offset-4 hover:decoration-foreground"
              >
                API Reference
              </Link>
              <Link
                href="/docs/guides"
                className="block font-mono text-[11px] underline decoration-border underline-offset-4 hover:decoration-foreground"
              >
                Guides
              </Link>
            </nav>
          </div>

          {/* Resources */}
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Resources
            </div>
            <nav className="mt-3 space-y-2">
              <a
                href="https://github.com/jeffsee55/wildwood"
                target="_blank"
                rel="noopener noreferrer"
                className="block font-mono text-[11px] underline decoration-border underline-offset-4 hover:decoration-foreground"
              >
                GitHub
              </a>
              <Link
                href="/docs/contributing"
                className="block font-mono text-[11px] underline decoration-border underline-offset-4 hover:decoration-foreground"
              >
                Contributing
              </Link>
              <Link
                href="/docs/license"
                className="block font-mono text-[11px] underline decoration-border underline-offset-4 hover:decoration-foreground"
              >
                License
              </Link>
            </nav>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="mt-8 border-t border-border pt-6">
          <div className="flex flex-col items-center justify-between gap-4 md:flex-row">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              © {currentYear} wildwood
            </p>
            <p className="font-mono text-[10px] text-muted-foreground">
              Built with{" "}
              <code className="rounded border border-border bg-card px-1 py-0.5 text-[10px]">
                wildwood
              </code>
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
