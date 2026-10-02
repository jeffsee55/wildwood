import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
const root = process.env.WILDWOOD_REVIEW_DIST_DIR || ".next";
const traces = (await readdir(join(root, "server"), { recursive: true })).filter((name) =>
  name.endsWith(".nft.json"),
);
if (!traces.length) throw new Error("No deployment file traces found");
const forbidden = new Set();
for (const name of traces) {
  const trace = join(root, "server", name);
  const { files } = JSON.parse(await readFile(trace, "utf8"));
  for (const file of files) {
    const target = resolve(dirname(trace), file);
    if (
      /^\.env(?:\.|$)|\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$/.test(basename(target)) ||
      target.split(sep).includes(".git")
    )
      forbidden.add(target);
  }
}
if (forbidden.size)
  throw new Error(`Deployment tracing included local state: ${[...forbidden].join(", ")}`);
console.log(
  `Verified ${traces.length} deployment file traces: no local databases, env files, or Git metadata.`,
);
