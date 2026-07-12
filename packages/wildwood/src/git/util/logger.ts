import type { Root } from "mdast";

export class Logger {
  constructor(args: {
    name: string;
  }) {
    // Not used yet
    args;
  }

  log(...args: Parameters<typeof console.log>) {
    console.log(...args);
  }

  dir(message: unknown) {
    console.dir(message, { depth: null, colors: true });
  }

  print(message: object, log = true): unknown {
    const result = this.#walkAndReplace(message);
    if (log) {
      console.dir(result, { depth: null, colors: true });
      return;
    }

    return result;
  }

  /**
   * Walks through an object or array and replaces objects containing type: "root"
   * with "[[..markdown..]]" while preserving the rest of the object structure.
   * Also truncates strings with more than 3 newlines.
   * Also replaces Zod types with their .def.type property.
   * Filters out empty links and leafDirectives arrays.
   */
  #walkAndReplace(data: unknown): unknown {
    if (Array.isArray(data)) {
      return data.map((item) => this.#walkAndReplace(item));
    }

    if (data && typeof data === "object" && data !== null) {
      if ("raw" in data && typeof data.raw === "string") {
        // return { _preview: `${data.raw.slice(0, 50)} [...]` };
        data.raw = `${data.raw.slice(0, 30)} [...]`;
        // return;
      }
      // Check if this object has type: "root"
      if ("type" in data && data.type === "root") {
        if ("raw" in data && typeof data.raw === "string") {
          return `${data.raw.slice(0, 30)} [...]`;
        }
      }
      if (
        "_meta" in data &&
        typeof data._meta === "object" &&
        data._meta !== null
      ) {
        data._meta = {
          // @ts-expect-error
          path: data._meta.path,
          // @ts-expect-error
          oid: data._meta.oid,
          "...": "...",
        };
      }

      // Check if this is a Zod type (has def.type property)
      if (
        "def" in data &&
        data.def &&
        typeof data.def === "object" &&
        "type" in data.def
      ) {
        return `[Zod ${data.def.type}]`;
      }

      // Recursively walk through object properties
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        // For content field with markdown, replace the Root object with preview
        // but keep links and leafDirectives at the parent level
        if (
          key === "content" &&
          value &&
          typeof value === "object" &&
          "type" in value &&
          value.type === "root"
        ) {
          const d = value as Root;
          let firstTextChild: string | undefined;

          outerLoop2: for (const child of d.children) {
            switch (child.type) {
              case "heading":
              case "paragraph":
                {
                  const firstChild = child.children[0];
                  if (firstChild.type === "text") {
                    firstTextChild = firstChild.value;
                    break outerLoop2;
                  }
                }
                break;
              case "text":
                firstTextChild = child.value;
                break;
              default:
            }
          }
          if (firstTextChild) {
            result[key] = { _preview: `${firstTextChild} ... [markdown]` };
          } else {
            result[key] = { _preview: "[markdown]" };
          }
          continue;
        }

        // Skip links and leafDirectives if they're empty arrays
        if (
          (key === "links" || key === "leafDirectives") &&
          Array.isArray(value) &&
          value.length === 0
        ) {
          continue;
        }
        result[key] = this.#walkAndReplace(value);
      }
      return result;
    }

    // Handle strings - truncate if more than 3 newlines
    if (typeof data === "string") {
      const newlineCount = (data.match(/\n/g) || []).length;
      if (newlineCount > 3) {
        const lines = data.split("\n");
        return `${lines.slice(0, 4).join("\n")}\n...`;
      }
    }

    // Return primitive values as-is
    return data;
  }
}
