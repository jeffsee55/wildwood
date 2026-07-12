import { Markdown } from "tr33/react/markdown";
import { tr33 } from "@/lib/tr33";
import type { DocPage } from "@/lib/content";

export default async function Home() {
  const res = (await tr33.docs.findMany({})) as unknown as { items: DocPage[] };
  const current = res.items.toSorted((a, b) => a.title.localeCompare(b.title))[0] ?? null;

  return (
    <div>
      <div className="mb-10 rounded-3xl border border-[color:var(--border)] bg-white p-8 shadow-sm">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-[color:var(--muted)]">
          Powered by Tr33
        </p>
        <h1 className="mt-4 text-5xl font-semibold tracking-tight">
          Docs from this repo&apos;s content folder
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-[color:var(--muted)]">
          Source is <code>content/</code>; queries use <code>tr33.docs.findMany()</code>. Slug and path are first-class.
        </p>
      </div>

      {current ? (
        <article className="rounded-3xl border border-[color:var(--border)] bg-white p-8 shadow-sm">
          <Markdown root={current.body} />
        </article>
      ) : (
        <div className="rounded-3xl border border-[color:var(--border)] bg-white p-8 text-[color:var(--muted)] shadow-sm">
          No docs found in <code>content/docs</code>.
        </div>
      )}
    </div>
  );
}
