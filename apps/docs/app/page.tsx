import Link from "next/link";
import { Toolbar } from "tr33/nextjs";

import { getDocsIndex, Markdown, slugFromDocPath } from "@/lib/content";
import { getDocsTr33 } from "@/lib/tr33";

export default async function Home() {
  const { docs, nav } = await getDocsIndex();
  const current = docs[0];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl gap-10 px-6 py-10">
      <aside className="hidden w-64 shrink-0 border-r border-[color:var(--border)] pr-8 lg:block">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-[color:var(--muted)]">
          {nav?.label ?? "Documentation"}
        </p>
        <nav className="mt-6 space-y-2">
          {docs.map((doc) => (
            <Link
              key={doc._meta.path}
              href={`/docs/${slugFromDocPath(doc._meta.path)}`}
              className="block rounded-xl px-3 py-2 text-sm text-[color:var(--muted)] hover:bg-white hover:text-foreground"
            >
              {doc.title}
            </Link>
          ))}
        </nav>
      </aside>

      <section className="min-w-0 flex-1">
        <div className="mb-10 rounded-3xl border border-[color:var(--border)] bg-white p-8 shadow-sm">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-[color:var(--muted)]">
            Powered by Tr33
          </p>
          <h1 className="mt-4 text-5xl font-semibold tracking-tight">
            Docs from this repo&apos;s content folder
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-[color:var(--muted)]">
            This app is the example users should copy: a typed Tr33 client,
            local repository source, collection queries, and the shared editing
            API mounted under Next.
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
      </section>

      <Toolbar tr33={getDocsTr33()} apiBase="/api" theme="light" />
    </main>
  );
}
