import { load, dump } from "js-yaml";
import { z } from "zod";
import type {
  BlobStore,
  Collection,
  Collections,
  Config,
  ContentCodec,
  SqlDatabase,
} from "./types";
import { ContentEngine } from "./engine";
export * from "./types";
export { ContentEngine } from "./engine";
export { libsql } from "./storage";

function patchFields(
  schema: Record<string, unknown>,
  value: unknown,
  fields: Record<string, unknown>,
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Field edits require an object document");
  const properties = schema.properties as Record<string, unknown> | undefined;
  for (const key of Object.keys(fields)) {
    if (
      ["__proto__", "constructor", "prototype"].includes(key) ||
      !properties ||
      !Object.hasOwn(properties, key)
    )
      throw new Error(`Unknown or unsafe field: ${key}`);
  }
  return { ...value, ...fields };
}
export function json<T>(schema: z.ZodType<T>): ContentCodec<T> {
  const jsonSchema = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  return Object.assign((source: string) => schema.parse(JSON.parse(source)), {
    format: "json" as const,
    jsonSchema,
    patch(source: string, fields: Record<string, unknown>) {
      const value = patchFields(jsonSchema, JSON.parse(source), fields);
      schema.parse(value);
      return JSON.stringify(value, null, 2) + "\n";
    },
  });
}
function markdownParts(source: string) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  const metadata = match ? load(match[1]) : {};
  if (metadata !== null && (typeof metadata !== "object" || Array.isArray(metadata)))
    throw new Error("Frontmatter must be an object");
  return { ...(metadata as object), body: match ? source.slice(match[0].length) : source };
}
/** Markdown is retained as source text; callers may transform it with their codec. */
export function markdown<T>(schema: z.ZodType<T>): ContentCodec<T> {
  const jsonSchema = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  return Object.assign((source: string) => schema.parse(markdownParts(source)), {
    format: "markdown" as const,
    jsonSchema,
    patch(source: string, fields: Record<string, unknown>) {
      const value = patchFields(jsonSchema, markdownParts(source), fields);
      schema.parse(value);
      const { body, ...metadata } = value as Record<string, unknown>;
      if (typeof body !== "string") throw new Error("Markdown body must be text");
      // Body edits must not create unrelated frontmatter conflicts between agent branches.
      if (Object.keys(fields).every((key) => key === "body")) {
        const original = markdownParts(source).body;
        return source.slice(0, source.length - original.length) + body;
      }
      return `---\n${dump(metadata, { lineWidth: -1, noRefs: true })}---\n${body}`;
    },
  });
}
export function collection<T>(definition: Collection<T>): Collection<T> {
  return definition;
}
export function createContent<const C extends Collections>(
  options: Config<C> & { database: SqlDatabase; blobs?: BlobStore; assetBlobs?: BlobStore },
): ContentEngine<C> {
  const { database, blobs, assetBlobs, ...config } = options;
  return new ContentEngine(database, config, blobs, assetBlobs);
}
