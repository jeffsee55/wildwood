import { createHash } from "node:crypto";
import { get, put } from "@vercel/blob";
import type { BlobStore } from "wildwood-core";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Optional private storage. Requests still go through Wildwood's snapshot authorization. */
export function vercelAssetBlobs(token: string): BlobStore {
  const path = (id: string) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid asset identity");
    return `wildwood-manual/assets/${id}`;
  };
  async function read(id: string) {
    const result = await get(path(id), { access: "private", token, useCache: false });
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream) throw new Error("Asset download failed");
    const bytes = new Uint8Array(await new Response(result.stream).arrayBuffer());
    if (digest(bytes) !== id) throw new Error("Corrupt asset");
    return bytes;
  }
  return {
    get: read,
    async put(id, bytes) {
      if (digest(bytes) !== id) throw new Error("Asset identity mismatch");
      try {
        await put(path(id), Buffer.from(bytes), {
          access: "private",
          token,
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: "application/octet-stream",
        });
      } catch (error) {
        // Identical retries and concurrent writers may have already stored this hash.
        const existing = await read(id).catch(() => null);
        if (!existing) throw error;
      }
    },
  };
}
