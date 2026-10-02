import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileBlobs } from "../src/filesystem";
import { hash } from "../src/storage";

test("filesystem bytes are atomically published, deduplicated and verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "ww-blobs-"));
  try {
    const store = fileBlobs(root),
      bytes = new Uint8Array([0, 255, 32]),
      id = hash(bytes);
    await Promise.all([store.put(id, bytes), store.put(id, bytes)]);
    expect(await store.get(id)).toEqual(Buffer.from(bytes));
    expect(await readdir(root)).toEqual([id]);
    await expect(store.put(id, new Uint8Array([1]))).rejects.toThrow("identity mismatch");
    await writeFile(join(root, id), "corrupt");
    await expect(store.put(id, bytes)).rejects.toThrow("corrupt");
    expect(await store.get("0".repeat(64))).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
