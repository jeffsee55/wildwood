import type { Document } from "wildwood-core";
export type ContentMap = {
  v: 1;
  repository: string;
  snapshot: string;
  version: string;
  variant: Readonly<Record<string, string>>;
  source: string;
  canonical: string;
  path: readonly (string | number)[];
};
export type MappedDocument<T> = Document<T> & { __sourcemap: ContentMap };
/** Attach metadata to a result envelope, never to persisted content or a shared cached object. */
export function withSourcemap<T>(repository: string, doc: Document<T>): MappedDocument<T> {
  return {
    ...doc,
    __sourcemap: {
      v: 1,
      repository,
      snapshot: doc.snapshot,
      version: doc.version,
      variant: doc.variant,
      source: doc.path,
      canonical: doc.canonical,
      path: [],
    },
  };
}
export function sourcemap<T>(
  doc: MappedDocument<T> | null | undefined,
  field?: string | readonly (string | number)[],
) {
  if (!doc) return {};
  return {
    "data-ww-contentmap": JSON.stringify({
      ...doc.__sourcemap,
      path: field === undefined ? [] : typeof field === "string" ? [field] : field,
    }),
  };
}
