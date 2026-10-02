import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { getContext, readDocs, slugOf } from "@/lib/wildwood";
import { sourcemap } from "wildwood-web/sourcemap";
async function document(slug: string) {
  const ctx = await getContext();
  const docs = await readDocs(ctx.snapshot, ctx.version, ctx.locale);
  const doc = docs.find((item) => slugOf(item.canonical) === slug);
  if (!doc) notFound();
  return { ctx, doc };
}
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { doc } = await document((await params).slug);
  return { title: doc.value.title, description: doc.value.description };
}
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { ctx, doc } = await document((await params).slug);
  return (
    <article>
      <p className="eyebrow">THE MANUAL / {ctx.locale.toUpperCase()}</p>
      <h1 {...sourcemap(doc, "title")}>{doc.value.title}</h1>
      <p className="lede" {...sourcemap(doc, "description")}>
        {doc.value.description}
      </p>
      <p className="byline">
        By <span {...sourcemap(doc.author, "name")}>{doc.author?.value.name || "Wildwood"}</span>
        {doc.value.audience && <> · For {doc.value.audience}</>}
      </p>
      <div className="typeset typeset-docs" {...sourcemap(doc, "body")}>
        <Markdown>{doc.value.body}</Markdown>
      </div>
    </article>
  );
}
