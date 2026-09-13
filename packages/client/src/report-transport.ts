import {
  ExecutionReportV1Schema,
  type ExecutionReportV1,
} from "@one-fetch/protocol";

const MAX_REPORT_BYTES = 49_152;

export type ReportAttempt =
  | { state: "pending" | "retry" | "unavailable" }
  | { state: "ready"; report: ExecutionReportV1 };

function discard(body: ReadableStream<Uint8Array> | null): void {
  if (body) void body.cancel().catch(() => undefined);
}

async function readReport(
  response: Response,
  signal: AbortSignal,
): Promise<ExecutionReportV1> {
  const declared = response.headers.get("Content-Length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAX_REPORT_BYTES)
  ) {
    discard(response.body);
    throw new TypeError("Invalid report size");
  }
  if (!response.body) throw new TypeError("Missing report body");
  const reader = response.body.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_REPORT_BYTES)
        throw new RangeError("Report exceeds size limit");
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return ExecutionReportV1Schema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

// Separate from the administrator client: never send an admin token, ambient
// cookies, target metadata or referrer. Never follow a Control redirect.
export async function fetchExecutionReport(
  url: URL,
  token: string,
  signal: AbortSignal,
  fetch: typeof globalThis.fetch,
): Promise<ReportAttempt> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal,
    });
  } catch {
    return { state: "retry" };
  }
  if (signal.aborted) {
    discard(response.body);
    return { state: "unavailable" };
  }
  if (response.status !== 200 || response.redirected) {
    discard(response.body);
    return {
      state:
        response.status === 404
          ? "pending"
          : response.status === 429 || response.status >= 500
            ? "retry"
            : "unavailable",
    };
  }
  try {
    return { state: "ready", report: await readReport(response, signal) };
  } catch {
    return { state: "unavailable" };
  }
}
