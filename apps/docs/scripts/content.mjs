import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const files = [];
async function visit(path) {
  for (const entry of await readdir(new URL(path, root), { withFileTypes: true })) {
    const name = `${path}${entry.name}`;
    if (entry.isDirectory()) await visit(`${name}/`);
    else files.push({ path: name, content: await readFile(new URL(name, root), "utf8") });
  }
}
await visit("content/");
files.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(
  fileURLToPath(new URL("lib/content.generated.json", root)),
  JSON.stringify(files, null, 2) + "\n",
);
