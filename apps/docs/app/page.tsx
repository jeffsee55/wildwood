import Link from "next/link";
import { Markdown } from "wildwood/react/markdown";
import { wildwood } from "@/lib/wildwood";

export default async function Home() {
  const r = await wildwood.docs.findMany({});
  const current = r.items.toSorted((a, b) => a.title.localeCompare(b.title))[0] ?? null;

  return (
    <div className="typeset typeset-man">
      <section>
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          name
        </div>
        <h1 className="!mt-3 !border-0 !pt-0 !text-[28px] !font-semibold !normal-case !tracking-[-0.03em]">
          wildwood — git as content store
        </h1>
        <p className="!mt-5 max-w-[60ch] !leading-[1.95] text-muted-foreground">
          Markdown and JSON in <code>content/</code> → typed collection API. Edits go through a
          shared H3/HTTP surface that powers both the floating editor and your own routes. This site
          is <code>content/</code> from this repo rendered through itself.
        </p>

        <div className="mt-8 grid gap-3 border border-border p-4 font-mono text-[11px] leading-[1.9]">
          <div className="flex gap-3">
            <span className="w-[5.5rem] shrink-0 uppercase tracking-[0.12em] text-muted-foreground">
              synopsis
            </span>
            <span>
              <code>wildwood.docs.findMany()</code> · <code>with:{"{author:true}"}</code> ·{" "}
              <code>wildwood/api</code> · <code>draftMode()</code> per-user
            </span>
          </div>
          <div className="flex gap-3">
            <span className="w-[5.5rem] shrink-0 uppercase tracking-[0.12em] text-muted-foreground">
              source
            </span>
            <Link
              className="underline decoration-border underline-offset-4 hover:decoration-foreground"
              href="https://github.com/jeffsee55/wildwood"
            >
              jeffsee55/wildwood
            </Link>
          </div>
        </div>
      </section>

      <section>
        <h2>description</h2>
        {current ? (
          <div className="typeset typeset-docs max-w-none border-t border-border pt-6">
            <Markdown root={current.body} />
          </div>
        ) : (
          <p className="border border-dashed border-border p-4 font-mono text-[11px] text-muted-foreground">
            no docs found in <code>content/docs</code>.
          </p>
        )}
      </section>

      <section>
        <h2>files</h2>
        <dl className="mt-4 grid grid-cols-[12rem_1fr] gap-x-6 gap-y-3 border-t border-border pt-5 font-mono text-[11px] leading-[1.9]">
          <dt className="uppercase tracking-[0.08em] text-muted-foreground">
            content/docs/**/*.md
          </dt>
          <dd>
            markdown collections — <code>z.markdown()</code>
          </dd>
          <dt className="uppercase tracking-[0.08em] text-muted-foreground">
            content/nav/index.json
          </dt>
          <dd>
            nav collection — <code>z.json()</code> with <code>z.connect()</code>
          </dd>
          <dt className="uppercase tracking-[0.08em] text-muted-foreground">
            app/api/[...path]/route.ts
          </dt>
          <dd>
            one catch-all: <code>createWildwoodRoute</code> owns <code>/git/*</code>,{" "}
            <code>/wildwood/draft</code>, <code>/wildwood/preview</code>
          </dd>
        </dl>
      </section>
    </div>
  );
}
