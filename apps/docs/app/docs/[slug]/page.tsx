import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Toolbar } from "tr33/nextjs";

import {
  getDocBySlug,
  getDocsIndex,
  Markdown,
  slugFromDocPath,
} from "@/lib/content";
import { tr33 } from "@/lib/tr33";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  const { docs } = await getDocsIndex();
  return docs.map((doc) => ({ slug: slugFromDocPath(doc._meta.path) }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = await getDocBySlug(slug);
  if (!doc) {
    return {
      title: "Not found | Tr33 Docs",
    };
  }

  return {
    title: `${doc.title} | Tr33 Docs`,
    description: doc.description,
  };
}

export default async function DocsPage({ params }: PageProps) {
  const { slug } = await params;
  const [{ docs, nav }, doc] = await Promise.all([
    getDocsIndex(),
    getDocBySlug(slug),
  ]);
  if (!doc) {
    notFound();
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl gap-10 px-6 py-10">
      <aside className="hidden w-64 shrink-0 border-r border-[color:var(--border)] pr-8 lg:block">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Tr33 Docs
        </Link>
        <p className="mt-3 text-sm text-[color:var(--muted)]">
          {nav?.label ?? "Documentation"}
        </p>
        <nav className="mt-6 space-y-2">
          {docs.map((item) => {
            const itemSlug = slugFromDocPath(item._meta.path);
            const active = itemSlug === slug;
            return (
              <Link
                key={item._meta.path}
                href={`/docs/${itemSlug}`}
                className={`block rounded-xl px-3 py-2 text-sm ${
                  active
                    ? "bg-[#171412] text-white"
                    : "text-[color:var(--muted)] hover:bg-white hover:text-foreground"
                }`}
              >
                {item.title}
              </Link>
            );
          })}
        </nav>
      </aside>

      <article className="min-w-0 flex-1 rounded-3xl border border-[color:var(--border)] bg-white p-8 shadow-sm">
        <div className="mb-8 border-b border-[color:var(--border)] pb-8">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-[color:var(--muted)]">
            {doc.author?.name ? `By ${doc.author.name}` : "Documentation"}
          </p>
          <h1 className="mt-4 text-5xl font-semibold tracking-tight">
            {doc.title}
          </h1>
          {doc.description ? (
            <p className="mt-5 max-w-3xl text-lg leading-8 text-[color:var(--muted)]">
              {doc.description}
            </p>
          ) : null}
        </div>
        <Markdown root={doc.body} />
      </article>

      <Toolbar tr33={tr33} apiBase="/api" theme="light" />
    </main>
  );
}
