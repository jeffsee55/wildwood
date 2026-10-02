import type { Config, Scalar } from "./types";

export function validPath(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    path.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
  ) {
    throw new Error(`Invalid repository path: ${JSON.stringify(path)}`);
  }
  return path;
}
export function variantInfo(path: string, variants: Config["variants"]) {
  let canonical = path;
  const explicit: Record<string, string> = {};
  for (const [axis, spec] of Object.entries(variants ?? {})) {
    if (spec.path === "folder") {
      const parts = canonical.split("/");
      const index = parts.findIndex((p, i) => i < parts.length - 1 && spec.options.includes(p));
      if (index !== -1) {
        explicit[axis] = parts[index];
        parts.splice(index, 1);
        canonical = parts.join("/");
      }
    } else {
      const parts = canonical.split("/");
      const name = parts.pop()!.split(".");
      const index = name.findIndex(
        (p, i) => i > 0 && i < name.length - 1 && spec.options.includes(p),
      );
      if (index !== -1) {
        explicit[axis] = name[index];
        name.splice(index, 1);
        canonical = [...parts, name.join(".")].join("/");
      }
    }
  }
  return { canonical, explicit };
}
/** Preserve default matches, explicit specificity, then declared-axis precedence. */
export function variantSql(variants: Config["variants"], input: Record<string, string> = {}) {
  const axes = Object.entries(variants ?? {});
  for (const key of Object.keys(input))
    if (!variants?.[key]) throw new Error(`Unknown variant axis: ${key}`);
  const args: Scalar[] = [];
  const allowed: string[] = [],
    matches: string[] = [],
    explicit: string[] = [],
    precedence: string[] = [];
  for (const [key, spec] of axes) {
    const value = input[key] ?? spec.default;
    if (!spec.options.includes(value)) throw new Error(`Invalid ${key}: ${value}`);
    // Axis names are validated at construction, never interpolated from a query.
    const expr = `json_extract(p.axes, '$.${key}')`;
    allowed.push(`(${expr} IS NULL OR ${expr} = ?)`);
    args.push(value);
    matches.push(`CASE WHEN COALESCE(${expr}, ?) = ? THEN 1 ELSE 0 END`);
    explicit.push(`CASE WHEN ${expr} IS NOT NULL THEN 1 ELSE 0 END`);
    precedence.push(`CASE WHEN ${expr} IS NOT NULL THEN 1 ELSE 0 END DESC`);
  }
  const scoreArgs = axes.flatMap(([key, spec]) => [spec.default, input[key] ?? spec.default]);
  return {
    allowed: allowed.join(" AND ") || "1=1",
    args,
    order: axes.length
      ? `${matches.join(" + ")} DESC, ${explicit.join(" + ")} DESC, ${precedence.join(", ")}, p.path`
      : "p.path",
    scoreArgs,
  };
}
