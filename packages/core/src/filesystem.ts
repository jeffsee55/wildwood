import { mkdir, readFile, writeFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hash } from "./storage";
import type { BlobStore } from "./types";
/** Durable local content-addressed storage; put publishes only complete files. */
export function fileBlobs(directory: string): BlobStore {
  const pathFor = (id: string) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid content identity");
    return join(directory, id);
  };
  return {
    async put(id, bytes) {
      const target = pathFor(id);
      if (hash(bytes) !== id) throw new Error("Blob identity mismatch");
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `.pending-${randomUUID()}`);
      try {
        await writeFile(temporary, bytes, { flag: "wx" });
        try {
          await link(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (hash(await readFile(target)) !== id)
            throw new Error("Existing blob is corrupt", { cause: error });
        }
      } finally {
        await unlink(temporary).catch(() => {});
      }
    },
    async get(id) {
      try {
        return await readFile(pathFor(id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}
