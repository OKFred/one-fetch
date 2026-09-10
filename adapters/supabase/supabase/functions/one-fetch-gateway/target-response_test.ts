import { streamTerminalRecord } from "./target-response.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test(
  "An oversized streamed target remains a partial target report",
  () => {
    const terminal = streamTerminalRecord(
      false,
      false,
      "response_too_large",
      true,
    );
    assert(terminal.outcome === "partial", "oversized stream was not partial");
    assert(terminal.source === "target", "oversized stream lost target source");
  },
);

Deno.test(
  "Completed, timed out, and cancelled stream records stay distinct",
  () => {
    assert(
      streamTerminalRecord(true, false, undefined, false).outcome ===
        "completed",
      "completed stream changed outcome",
    );
    assert(
      streamTerminalRecord(false, true, "stream_error", true).outcome ===
        "timeout",
      "timeout lost precedence",
    );
    assert(
      streamTerminalRecord(false, false, "cancelled", true).outcome ===
        "cancelled",
      "cancelled stream changed outcome",
    );
  },
);
