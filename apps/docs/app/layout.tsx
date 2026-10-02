import type { Metadata } from "next";
import Link from "next/link";
import { getContext, readDocs, slugOf } from "@/lib/wildwood";
import { contentAction, preferences } from "@/lib/actions";
// oxlint-disable-next-line import/no-unassigned-import -- Global styles are a required side effect.
import "./globals.css";
import { Toolbar } from "wildwood-web/next";
import { sourcemap } from "wildwood-web/sourcemap";
import { getWeb } from "@/lib/cms";
import { LanguageControls } from "./language-controls";
import { previewOnly } from "@/lib/content";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: { default: "Wildwood — immutable content", template: "%s — Wildwood" },
  description: "A working manual for immutable, Git-compatible content.",
};
export default async function Layout({ children }: { children: React.ReactNode }) {
  const ctx = await getContext();
  const docs = await readDocs(ctx.snapshot, ctx.version, ctx.locale);
  const web = await getWeb();
  const toolbarState = await web.state(ctx);
  return (
    <html lang={ctx.locale}>
      <body>
        <div className="manual">
          <header>
            <Link href="/" className="brand">
              wildwood<span> / manual</span>
            </Link>
            <span data-testid="content-mode">
              {previewOnly
                ? "READ-ONLY PREVIEW"
                : ctx.pinned
                  ? "PINNED"
                  : ctx.preview
                    ? "DRAFT"
                    : "PUBLISHED"}
            </span>
          </header>
          <div className="controls">
            <form key={`${ctx.locale}-${ctx.version}`} action={preferences}>
              <LanguageControls locale={ctx.locale} pinned={ctx.pinned} />
            </form>
          </div>
          <div className="columns">
            <aside>
              <p className="eyebrow">THE MANUAL</p>
              <nav>
                {docs.map((doc) => (
                  <Link
                    {...sourcemap(doc, "title")}
                    key={doc.canonical}
                    href={`/docs/${slugOf(doc.canonical)}`}
                  >
                    {doc.value.title}
                  </Link>
                ))}
              </nav>
              <p className="snapshot">
                Snapshot
                <br />
                <code data-testid="snapshot">{ctx.snapshot.slice(0, 12)}</code>
              </p>
              <p className="muted">
                {ctx.preview
                  ? "Your view is isolated from published content."
                  : "Published content. Drafts stay private behind signed preview access."}
              </p>
            </aside>
            <main>{children}</main>
          </div>
          <footer>Wildwood / agents draft · humans review · publish with confidence</footer>
        </div>
        <Toolbar state={toolbarState} asset={web.asset} action={contentAction} />
      </body>
    </html>
  );
}
