/** Bundle the build image's Git and its ELF dependencies. Runtime workspaces remain disposable. */
import { execFileSync } from "node:child_process";
import { mkdir, copyFile, writeFile, chmod } from "node:fs/promises";
import { basename, resolve } from "node:path";
if (process.platform === "linux" && process.env.VERCEL) {
  const directory = resolve(".git-runtime");
  await mkdir(directory, { recursive: true });
  const binary = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const listing = execFileSync("ldd", [binary], { encoding: "utf8" });
  const paths = [...listing.matchAll(/(?:=>\s*)?(\/[^\s]+)/g)].map((m) => m[1]);
  const loader = paths.find((p) => /ld-linux|ld-musl/.test(p));
  if (!loader) throw new Error("Cannot identify Git ELF loader");
  for (const path of new Set(paths)) await copyFile(path, resolve(directory, basename(path)));
  await copyFile(binary, resolve(directory, "git.bin"));
  const wrapper = `#!/bin/sh\nbase="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexport PATH="$base:$PATH"\nexport GIT_EXEC_PATH="$base"\nexec "$base/${basename(loader)}" --library-path "$base" "$base/git.bin" "$@"\n`;
  await writeFile(resolve(directory, "git"), wrapper);
  await chmod(resolve(directory, "git"), 0o755);
  console.log(
    "Bundled native Git:",
    execFileSync(resolve(directory, "git"), ["--version"], { encoding: "utf8" }).trim(),
  );
}
