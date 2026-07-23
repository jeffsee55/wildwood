import type { Metadata } from "next";
import Link from "next/link";
import { cacheLife, cacheTag } from "next/cache";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Markdown } from "wildwood/react/markdown";
import { WILDWOOD_CONTENT_TAG, createReadClient, getContext } from "@/lib/wildwood";

type PageProps = { params: Promise<{ slug: string }> };

function resolveHref(href: string): string {
  if (!href) return "#";
  if (href.endsWith(".md")) return `/docs/${href.replace(/^\.\//, "").replace(/\.md$/, "")}`;
  return href;
}

async function getDoc(opts: { slug: string; branch: string; isDraft: boolean }) {
  "use cache";
  cacheLife("hours");
  cacheTag(WILDWOOD_CONTENT_TAG, `wildwood:branch:${opts.branch}`, `wildwood:doc:${opts.slug}`);

  const ww = createReadClient();
  return ww.docs.findFirst({
    ref: opts.branch,
    where: { slug: opts.slug },
    with: { author: true },
  });
}

export async function generateStaticParams() {
  "use cache";
  cacheLife("hours");
  cacheTag(WILDWOOD_CONTENT_TAG);

  const ww = createReadClient();
  const res = await ww.docs.findMany({ ref: "main" }).catch(() => ({
    items: [] as { slug: string }[],
  }));
  return res.items.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const { branch, isDraft } = await getContext();
  const res = await getDoc({ slug, branch, isDraft });
  if (!res.value) return { title: "not found — wildwood(1)" };
  return { title: `${res.value.title} — wildwood(1)`, description: res.value.description };
}

export default async function DocsPage({ params }: PageProps) {
  const { slug } = await params;
  return (
    <Suspense fallback={<DocsFallback slug={slug} />}>
      <DocsContent slug={slug} />
    </Suspense>
  );
}

function DocsFallback({ slug }: { slug: string }) {
  return (
    <div className="typeset typeset-man">
      <div className="border-b border-border pb-8">
        <div className="h-4 w-24 animate-pulse rounded bg-muted/30" />
        <div className="mt-5 h-8 w-64 animate-pulse rounded bg-muted/30" />
      </div>
      <div className="mt-8 h-72 animate-pulse rounded bg-muted/15" />
      <div className="mt-2 font-mono text-[11px] text-muted-foreground">loading {slug}…</div>
    </div>
  );
}

async function DocsContent({ slug }: { slug: string }) {
  const { branch, isDraft } = await getContext();
  const res = await getDoc({ slug, branch, isDraft });
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

        <h1 className="mt-5! border-0! pt-0! text-[26px]! normal-case! tracking-[-0.02em]!">{doc.title.toLowerCase()}</h1>

        {doc.description ? (
          <p className="mt-3! max-w-[60ch] text-[12.5px]! leading-[1.95]! text-muted-foreground">{doc.description}</p>
        ) : null}
      </header>

      <Markdown
        root={doc.body}
        components={{
          a: ({ href, children, ...rest }) => (
            <Link href={resolveHref(href ?? "#")} {...(rest as { href?: string })}>
              {children}
            </Link>
          ),
        }}
      />

      <footer className="mt-16 border-t border-border pt-6 font-mono text-[11px] leading-[1.9] text-muted-foreground">
        <div className="uppercase tracking-[0.12em]">see also</div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          <Link className="block underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/intro">
            intro
          </Link>
          <Link className="block underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/configuration">
            configuration
          </Link>
          <Link className="block underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/schemas">
            schemas
          </Link>
          <Link className="block underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/querying">
            querying
          </Link>
          <Link className="block underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/variants">
            variants
          </Link>
          <Link className="block underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/branching">
            branching
          </Link>
          <Link className="block underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/editor-routes">
            editor-routes
          </Link>
          <Link className="block underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/kit">
            kit
          </Link>
          <Link className="block underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/deploy">
            deploy
          </Link>
          <Link className="block underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/api">
            api
          </Link>
          <Link className="block underline decoration-border underline-offset-4 hover:decoration-foreground" href="/docs/guides">
            guides
          </Link>
        </div>
      </footer>
    </div>
  );
}
