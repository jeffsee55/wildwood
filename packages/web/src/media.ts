/** Only inert, recognized media formats render inline. Active formats are downloads. */
export function mediaType(bytes: Uint8Array): {
  type: string;
  kind: "image" | "audio" | "video" | "file";
} {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { type: "image/png", kind: "image" };
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return { type: "image/jpeg", kind: "image" };
  if (["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString()))
    return { type: "image/gif", kind: "image" };
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP")
    return { type: "image/webp", kind: "image" };
  if (
    b.subarray(4, 8).toString() === "ftyp" &&
    ["avif", "avis"].includes(b.subarray(8, 12).toString())
  )
    return { type: "image/avif", kind: "image" };
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WAVE")
    return { type: "audio/wav", kind: "audio" };
  if (b.subarray(0, 3).toString() === "ID3") return { type: "audio/mpeg", kind: "audio" };
  if (b.subarray(0, 4).toString() === "OggS") return { type: "audio/ogg", kind: "audio" };
  if (b.subarray(4, 8).toString() === "ftyp") return { type: "video/mp4", kind: "video" };
  if (b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])))
    return { type: "video/webm", kind: "video" };
  return { type: "application/octet-stream", kind: "file" };
}
export function mediaResponse(bytes: Uint8Array, path: string, request: Request) {
  const media = mediaType(bytes);
  const headers = new Headers({
    "content-type": media.type,
    "content-length": String(bytes.length),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
    "content-disposition": `${media.kind === "file" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(path.split("/").pop() || "file")}`,
    "accept-ranges": "bytes",
  });
  const range = request.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = m?.[1] ? Number(m[1]) : m?.[2] ? Math.max(0, bytes.length - Number(m[2])) : NaN;
    let end = m?.[1] && m?.[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= bytes.length
    ) {
      headers.set("content-range", `bytes */${bytes.length}`);
      headers.delete("content-length");
      return new Response(null, { status: 416, headers });
    }
    headers.set("content-range", `bytes ${start}-${end}/${bytes.length}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(
      request.method === "HEAD" ? null : new Uint8Array(bytes.slice(start, end + 1)),
      { status: 206, headers },
    );
  }
  return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), { headers });
}
