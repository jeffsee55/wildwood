import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const files = [];
async function visit(path) {
  for (const entry of await readdir(new URL(path, root), { withFileTypes: true })) {
    const name = `${path}${entry.name}`;
    if (entry.isDirectory()) await visit(`${name}/`);
    else {
      const encoding = name.endsWith(".md") ? "utf8" : "base64";
      files.push({ path: name, encoding, content: await readFile(new URL(name, root), encoding) });
    }
  }
}
await visit("content/");
await visit("media/");
files.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(
  fileURLToPath(new URL("lib/content.generated.json", root)),
  JSON.stringify(files, null, 2) + "\n",
);
