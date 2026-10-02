import { expect, test } from "vitest";
import { PayloadTooLarge, readBody } from "../src/http";

test("stream limits count bytes, cancel the source, and release its lock", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("éé"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://localhost", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  await expect(readBody(request, 7)).rejects.toBeInstanceOf(PayloadTooLarge);
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});
test("accepts exact limits and empty requests", async () => {
  expect(
    new TextDecoder().decode(
      await readBody(new Request("http://localhost", { method: "POST", body: "abcd" }), 4),
    ),
  ).toBe("abcd");
  expect(await readBody(new Request("http://localhost"), 4)).toHaveLength(0);
});
