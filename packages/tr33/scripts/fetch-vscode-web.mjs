/**
 * Downloads and extracts VS Code web assets into vendor/ (run via `pnpm run build` in tr33).
 * Runtime serves these files with long-lived Cache-Control headers.
 */
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";

const execFileAsync = promisify(execFile);
const tr33Root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = path.join(tr33Root, "vendor", "vscode-web");
const platform =
  process.env.TR33_VSCODE_WEB_PLATFORM || "server-linux-x64-web";

async function resolveVersion() {
  const override = process.env.TR33_VSCODE_WEB_VERSION?.trim();
  if (override && override !== "latest") {
    return override;
  }
  const response = await fetch(
    "https://update.code.visualstudio.com/api/releases/stable",
  );
  if (!response.ok) {
    throw new Error(`Failed to resolve VS Code version: ${response.status}`);
  }
  const versions = await response.json();
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error("No stable VS Code versions returned");
  }
  return versions[0];
}

async function resolveExtractedRoot(versionDir) {
  const expected = path.join(versionDir, `vscode-${platform}`);
  try {
    await stat(expected);
    return expected;
  } catch {
    const entries = await readdir(versionDir, { withFileTypes: true });
    const fallback = entries.find(
      (entry) => entry.isDirectory() && entry.name.startsWith("vscode-"),
    );
    if (!fallback) {
      throw new Error("VS Code web assets extracted, but root folder not found");
    }
    return path.join(versionDir, fallback.name);
  }
}

const version = await resolveVersion();
const versionDir = path.join(vendorRoot, `${platform}-${version}`);
const readyFile = path.join(versionDir, ".ready");

try {
  await stat(readyFile);
  const root = (await readFile(readyFile, "utf-8")).trim();
  const rootRelative = path.relative(vendorRoot, root);
  await writeFile(
    path.join(vendorRoot, "current.json"),
    `${JSON.stringify(
      {
        platform,
        version,
        versionDir: path.basename(versionDir),
        rootRelative,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  console.log(`vscode-web ${version} already at ${root}`);
  process.exit(0);
} catch {
  /* fetch */
}

await mkdir(versionDir, { recursive: true });
const tmpDir = await mkdtemp(path.join(tmpdir(), "tr33-vscode-web-"));
const archivePath = path.join(tmpDir, "vscode-web.tgz");
const downloadUrl = `https://update.code.visualstudio.com/${version}/${platform}/stable`;

console.log(`Downloading ${downloadUrl}`);
const response = await fetch(downloadUrl);
if (!response.ok) {
  throw new Error(`Failed to download VS Code web: ${response.status}`);
}
await pipeline(response.body, createWriteStream(archivePath));
await execFileAsync("tar", ["-xzf", archivePath, "-C", versionDir]);

const root = await resolveExtractedRoot(versionDir);
await writeFile(readyFile, `${root}\n`, "utf-8");
const rootRelative = path.relative(vendorRoot, root);
await writeFile(
  path.join(vendorRoot, "current.json"),
  `${JSON.stringify(
    {
      platform,
      version,
      versionDir: path.basename(versionDir),
      rootRelative,
    },
    null,
    2,
  )}\n`,
  "utf-8",
);
console.log(`vscode-web ${version} → ${root}`);
