import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "tr33/react/markdown";
import { tr33 } from "@/lib/tr33";

type PageProps = { params: Promise<{ slug: string }> };

function resolveHref(href: string): string {
  if (!href) return "#";
  if (href.endsWith(".md")) return `/docs/${href.replace(/^\.\//, "").replace(/\.md$/, "")}`;
  return href;
}

// Static params = all docs. No manual DocPage cast – inferred from schema + with.
export async function generateStaticParams() {
  const res = await tr33.docs.findMany({});
  return res.items.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const res = await tr33.docs.findFirst({
    where: { slug },
    with: { author: true },
  });
  if (!res.value) return { title: "Not found | Tr33 Docs" };
  return { title: `${res.value.title} | Tr33 Docs`, description: res.value.description };
}

export default async function DocsPage({ params }: PageProps) {
  const { slug } = await params;
  const res = await tr33.docs.findFirst({
    where: { slug },
    with: { author: true },
  });
  const doc = res.value;
  if (!doc) notFound();

  return (
    <article className="min-w-0 flex-1 rounded-3xl border border-[color:var(--border)] bg-white p-8 shadow-sm">
      <div className="mb-8 border-b border-[color:var(--border)] pb-8">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-[color:var(--muted)]">
          {doc.author?.name ? `By ${doc.author.name}` : "Documentation"}
        </p>
        <h1 className="mt-4 text-5xl font-semibold tracking-tight">{doc.title}</h1>
        {doc.description ? (
          <p className="mt-5 max-w-3xl text-lg leading-8 text-[color:var(--muted)]">{doc.description}</p>
        ) : null}
      </div>

      <Markdown
        root={doc.body}
        components={{
          a: ({ href, children, ...rest }) => (
            <Link
              href={resolveHref(href ?? "#")}
              className="font-medium text-foreground underline decoration-black/20 underline-offset-4 hover:decoration-black"
              {...rest}
            >
              {children}
            </Link>
          ),
        }}
        classNames={{
          h1: "mt-0 text-4xl font-semibold tracking-tight",
          h2: "mt-12 text-2xl font-semibold tracking-tight",
          h3: "mt-8 text-xl font-semibold tracking-tight",
          h4: "mt-6 text-lg font-semibold tracking-tight",
          p: "mt-5 leading-7 text-[color:var(--muted)]",
          ul: "mt-5 list-disc space-y-2 pl-6 leading-7 text-[color:var(--muted)]",
          ol: "mt-5 list-decimal space-y-2 pl-6 leading-7 text-[color:var(--muted)]",
          code: "mt-5 overflow-x-auto rounded-2xl border border-[color:var(--border)] bg-[#171412] p-4 text-sm text-white",
          blockquote: "mt-6 rounded-2xl border border-[color:var(--border)] bg-white p-5 text-[color:var(--muted)]",
          leafDirective: "mt-6 rounded-2xl border border-[color:var(--border)] bg-white p-5 text-[color:var(--muted)]",
          containerDirective:
            "mt-6 rounded-2xl border border-[color:var(--border)] bg-white p-5 text-[color:var(--muted)]",
          thematicBreak: "my-10 border-[color:var(--border)]",
        }}
      />
    </article>
  );
}
