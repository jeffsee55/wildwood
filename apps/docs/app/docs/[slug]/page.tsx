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
  if (!res.value) return { title: "not found — tr33(1)" };
  return { title: `${res.value.title} — tr33(1)`, description: res.value.description };
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
    <div className="typeset typeset-man">
      {/* man header — NAME(1) style */}
      <header className="border-b border-border pb-8">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <span>tr33(1)</span>
          {doc.author?.name ? <span>by {doc.author.name.toLowerCase()}</span> : <span>manual</span>}
          <span className="ml-auto tabular-nums">{doc._meta?.path ?? `${slug}.md`}</span>
        </div>

        <h1 className="!mt-5 !border-0 !pt-0 !text-[26px] !normal-case !tracking-[-0.02em]">{doc.title.toLowerCase()}</h1>

        {doc.description ? (
          <p className="!mt-3 max-w-[60ch] !text-[12.5px] !leading-[1.95] text-muted-foreground">{doc.description}</p>
        ) : null}
      </header>

      {/* typeset owns all rich-text rhythm — no per-element classNames needed */}
      <Markdown
        root={doc.body}
        components={{
          a: ({ href, children, ...rest }) => (
            <Link
              href={resolveHref(href ?? "#")}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              {...(rest as any)}
            >
              {children}
            </Link>
          ),
        }}
      />

      <footer className="mt-16 border-t border-border pt-6 font-mono text-[11px] leading-[1.9] text-muted-foreground">
        <div className="uppercase tracking-[0.12em]">see also</div>
        <div className="mt-2 flex gap-4">
          <Link className="underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/intro">
            tr33(1) intro
          </Link>
          <Link className="underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/api">
            tr33(5) api
          </Link>
          <Link className="underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/guides">
            tr33(7) guides
          </Link>
        </div>
      </footer>
    </div>
  );
}
