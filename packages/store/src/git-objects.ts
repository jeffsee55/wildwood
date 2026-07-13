import { concatU8, encodeUtf8, hexToBytes, sha1Hex } from "./crypto";
import type { CommitNode, TreeEntries } from "./types";

/** Canonical git empty tree (same as `git hash-object -t tree /dev/null`). */
export const GIT_EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export async function calculateBlobOid(content: string): Promise<string> {
  const body = encodeUtf8(content);
  const header = encodeUtf8(`blob ${body.length}\0`);
  return sha1Hex(concatU8([header, body]));
}

export async function calculateBlobOidFromBytes(content: Uint8Array): Promise<string> {
  const header = encodeUtf8(`blob ${content.length}\0`);
  return sha1Hex(concatU8([header, content]));
}

/**
 * Git sorts tree entries by name, but directories compare as if they
 * had a trailing '/' (so "foo" dir sorts as "foo/", after "foo-bar").
 */
function sortTreeEntryNames(entries: TreeEntries): string[] {
  return Object.keys(entries).sort((a, b) => {
    const keyA = entries[a].type === "tree" ? `${a}/` : a;
    const keyB = entries[b].type === "tree" ? `${b}/` : b;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
}

export async function calculateTreeOid(entries: TreeEntries): Promise<string> {
  const sortedNames = sortTreeEntryNames(entries);
  const entryChunks: Uint8Array[] = [];
  for (const name of sortedNames) {
    const childEntry = entries[name];
    const mode = childEntry.type === "blob" ? "100644" : "40000";
    const modeAndName = encodeUtf8(`${mode} ${name}\0`);
    const oidBinary = hexToBytes(childEntry.oid);
    entryChunks.push(modeAndName, oidBinary);
  }
  const content = concatU8(entryChunks);
  const header = encodeUtf8(`tree ${content.length}\0`);
  const storeBuffer = concatU8([header, content]);
  return sha1Hex(storeBuffer);
}

function formatTimezoneOffset(offset: number): string {
  const sign = offset >= 0 ? "+" : "-";
  const absOffset = Math.abs(offset);
  const hours = Math.floor(absOffset / 60);
  const minutes = absOffset % 60;
  return `${sign}${hours.toString().padStart(2, "0")}${minutes.toString().padStart(2, "0")}`;
}

export async function calculateCommitOid(commit: Omit<CommitNode, "oid">): Promise<string> {
  const lines: string[] = [];

  lines.push(`tree ${commit.treeOid}`);
  if (commit.parent) lines.push(`parent ${commit.parent}`);
  if (commit.secondParent) lines.push(`parent ${commit.secondParent}`);

  const authorTz = formatTimezoneOffset(commit.author.timezoneOffset);
  lines.push(
    `author ${commit.author.name} <${commit.author.email}> ${commit.author.timestamp} ${authorTz}`,
  );

  if (commit.committer) {
    const committerTz = formatTimezoneOffset(commit.committer.timezoneOffset);
    lines.push(
      `committer ${commit.committer.name} <${commit.committer.email}> ${commit.committer.timestamp} ${committerTz}`,
    );
  }

  lines.push("");
  lines.push(commit.message);

  const body = encodeUtf8(lines.join("\n"));
  const header = encodeUtf8(`commit ${body.length}\0`);
  return sha1Hex(concatU8([header, body]));
}
