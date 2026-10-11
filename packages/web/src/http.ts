/** Bound streamed bodies before decoding or parsing, including chunked requests. */
export class PayloadTooLarge extends Error {}
export async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new PayloadTooLarge(`Request exceeds ${limit / 1024} KiB`);
      }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}
