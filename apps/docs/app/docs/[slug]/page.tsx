import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "wildwood/react/markdown";
import { wildwood } from "@/lib/wildwood";

type PageProps = { params: Promise<{ slug: string }> };

function resolveHref(href: string): string {
  if (!href) return "#";
  if (href.endsWith(".md")) return `/docs/${href.replace(/^\.\//, "").replace(/\.md$/, "")}`;
  return href;
}

export async function generateStaticParams() {
  const res = (await wildwood.docs.findMany({})) as { items: Array<{ slug: string }> };
  return res.items.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const res = (await wildwood.docs.findFirst({
    where: { slug },
    with: { author: true },
  })) as { value: { title: string; description?: string } | null };
  if (!res.value) return { title: "not found — wildwood(1)" };
  return { title: `${res.value.title} — wildwood(1)`, description: res.value.description };
}

export default async function DocsPage({ params }: PageProps) {
  const { slug } = await params;
  const res = (await wildwood.docs.findFirst({
    where: { slug },
    with: { author: true },
  })) as {
    value: {
      title: string;
      description?: string;
      body: unknown;
      author?: { name?: string };
      _meta?: { path?: string };
      slug?: string;
    } | null;
  };
  const doc = res.value;
  if (!doc) notFound();

  return (
    <div className="typeset typeset-man">
      {/* man header — NAME(1) style */}
      <header className="border-b border-border pb-8">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <span>wildwood(1)</span>
          {doc.author?.name ? <span>by {(doc.author.name as string).toLowerCase()}</span> : <span>manual</span>}
          <span className="ml-auto tabular-nums">{(doc as { _meta?: { path?: string } })._meta?.path ?? `${slug}.md`}</span>
        </div>

        <h1 className="!mt-5 !border-0 !pt-0 !text-[26px] !normal-case !tracking-[-0.02em]">{(doc.title as string).toLowerCase()}</h1>

        {doc.description ? (
          <p className="!mt-3 max-w-[60ch] !text-[12.5px] !leading-[1.95] text-muted-foreground">{doc.description}</p>
        ) : null}
      </header>

      {/* typeset owns all rich-text rhythm — no per-element classNames needed */}
      <Markdown
        root={doc.body as never}
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
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          <Link className="underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/intro">
            intro
          </Link>
          <Link className="underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/configuration">
            configuration
          </Link>
          <Link className="underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/schemas">
            schemas
          </Link>
          <Link className="underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/querying">
            querying
          </Link>
          <Link className="underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/variants">
            variants
          </Link>
          <Link className="underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/branching">
            branching
          </Link>
          <Link className="underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/editor-routes">
            editor-routes
          </Link>
          <Link className="underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/kit">
            kit
          </Link>
          <Link className="underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/deploy">
            deploy
          </Link>
          <Link className="underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/api">
            api
          </Link>
          <Link className="underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/guides">
            guides
          </Link>
        </div>
      </footer>
    </div>
  );
}
