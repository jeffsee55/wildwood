import { sourcemap } from "wildwood-web/sourcemap";
import Link from "next/link";
import { getContext, readDocs, slugOf } from "@/lib/wildwood";
export default async function Home() {
  const ctx = await getContext();
  const docs = await readDocs(ctx.snapshot, ctx.version, ctx.locale);
  return (
    <>
      <p className="eyebrow">CONTENT MANAGEMENT FOR AGENTS</p>
      <h1>
        Your agent writes.
        <br />
        You stay in control.
      </h1>
      <p className="lede">
        Connect your agent. Work in a draft. Review the changes. Publish with confidence.
      </p>
      <p>
        This site is its own CMS. Its pages, translations, and author references are real content.
        Every edit starts in an isolated draft, and every preview keeps the version you shared.
      </p>
      <p>
        <a href="/cms/connect">Connect your agent →</a>
      </p>
      <div className="cards">
        {docs.map((doc) => (
          <Link href={`/docs/${slugOf(doc.canonical)}`} key={doc.canonical}>
            <h2 {...sourcemap(doc, "title")}>{doc.value.title} ↗</h2>
            <p {...sourcemap(doc, "description")}>{doc.value.description}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
