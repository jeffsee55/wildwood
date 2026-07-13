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
  const res = await wildwood.docs.findMany({});
  return res.items.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const res = await wildwood.docs.findFirst({ where: { slug }, with: { author: true } });
  if (!res.value) return { title: "not found — wildwood(1)" };
  return { title: `${res.value.title} — wildwood(1)`, description: res.value.description };
}

export default async function DocsPage({ params }: PageProps) {
  const { slug } = await params;
  const res = await wildwood.docs.findFirst({ where: { slug }, with: { author: true } });
  const doc = res.value;
  if (!doc) notFound();

  return (
    <div className="typeset typeset-man">
      <header className="border-b border-border pb-8">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <span>wildwood(1)</span>
          {doc.author?.name ? <span>by {doc.author.name.toLowerCase()}</span> : <span>manual</span>}
          <span className="ml-auto tabular-nums">{doc._meta.path ?? `${slug}.md`}</span>
        </div>

        <h1 className="!mt-5 !border-0 !pt-0 !text-[26px] !normal-case !tracking-[-0.02em]">{doc.title.toLowerCase()}</h1>

        {doc.description ? (
          <p className="!mt-3 max-w-[60ch] !text-[12.5px] !leading-[1.95] text-muted-foreground">{doc.description}</p>
        ) : null}
      </header>

      <Markdown
        root={doc.body}
        components={{
          a: ({ href, children, ...rest }) => (
            <Link href={resolveHref(href ?? "#")} {...(rest as { href?: string })}>{children}</Link>
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
