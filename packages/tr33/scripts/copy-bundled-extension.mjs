import { cp, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tr33Root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(tr33Root, "..", "extension");
const dest = path.join(tr33Root, "bundled-extension");

const required = ["dist/extension.js", "package.json", "themes/tr33-dark.json"];

async function assertExtensionBuilt() {
  for (const rel of required) {
    try {
      await access(path.join(extensionRoot, rel));
    } catch {
      throw new Error(
        `tr33-vscode is missing ${rel}. Run pnpm --filter tr33-vscode build before tr33 build.`,
      );
    }
  }
}

await assertExtensionBuilt();

await cp(path.join(extensionRoot, "dist"), path.join(dest, "dist"), {
  recursive: true,
});
await cp(path.join(extensionRoot, "themes"), path.join(dest, "themes"), {
  recursive: true,
});
for (const file of ["package.json", "package.nls.json"]) {
  await cp(path.join(extensionRoot, file), path.join(dest, file));
}

console.info("[tr33] copied tr33-vscode into bundled-extension/");
