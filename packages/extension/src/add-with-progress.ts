type AddStreamEvent =
  | { type: "progress"; message: string }
  | {
      type: "done";
      ref: string;
      files: Record<string, string>;
      rootTreeOid: string;
    }
  | { type: "error"; message: string };

export async function postAddWithProgress(
  apiUrl: string,
  args: {
    ref: string;
    files: Record<string, string | { base64: string }>;
  },
  onProgress: (message: string) => void,
): Promise<{
  ref: string;
  files: Record<string, string>;
  rootTreeOid: string;
}> {
  const res = await fetch(`${apiUrl}/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ ...args, stream: true }),
  });

  if (!res.body) {
    const err = await res.text().catch(() => "");
    throw new Error(
      err.trim() || `Failed to save (${res.status})`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let donePayload: {
    ref: string;
    files: Record<string, string>;
    rootTreeOid: string;
  } | null = null;
  let streamError: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let event: AddStreamEvent;
      try {
        event = JSON.parse(trimmed) as AddStreamEvent;
      } catch {
        streamError = trimmed;
        continue;
      }
      if (event.type === "progress") {
        onProgress(event.message);
      } else if (event.type === "done") {
        donePayload = {
          ref: event.ref,
          files: event.files,
          rootTreeOid: event.rootTreeOid,
        };
      } else if (event.type === "error") {
        streamError = event.message;
      }
    }
  }

  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim()) as AddStreamEvent;
      if (event.type === "progress") {
        onProgress(event.message);
      } else if (event.type === "done") {
        donePayload = {
          ref: event.ref,
          files: event.files,
          rootTreeOid: event.rootTreeOid,
        };
      } else if (event.type === "error") {
        streamError = event.message;
      }
    } catch {
      streamError = buffer.trim();
    }
  }

  if (streamError) {
    throw new Error(streamError);
  }
  if (!donePayload) {
    if (!res.ok) {
      throw new Error(`Failed to save (${res.status})`);
    }
    throw new Error("Save finished without a result");
  }
  if (!res.ok) {
    throw new Error(`Failed to save (${res.status})`);
  }
  return donePayload;
}
