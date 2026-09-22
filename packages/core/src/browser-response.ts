import {
  BrowserResponseModeV1Schema,
  FetchOptionCapabilityV1Schema,
  type FetchOptionsV1,
  type OneFetchUnsignedResponseMetaV1,
} from "@one-fetch/protocol";

/** Advertised in the existing extensible capability list, not a new required field. */
export const BROWSER_RESPONSE_CAPABILITY = FetchOptionCapabilityV1Schema.parse({
  option: "adapter.browserResponse",
  fidelity: "translated",
  acceptedValues: ["envelope-v1"],
  detail:
    "Opt-in HTTP 200 transport envelope. Target status and headers remain signed metadata; raw body streams unchanged. Prevents browser Fetch from hiding 3xx signatures. Never follow outer redirects.",
});

export function browserResponseMetadata(
  options: Pick<FetchOptionsV1, "adapter">,
): Pick<OneFetchUnsignedResponseMetaV1, "responseMode"> {
  return options.adapter?.browserResponse === "envelope-v1"
    ? { responseMode: BrowserResponseModeV1Schema.parse("browser-envelope-v1") }
    : {};
}

export function httpTransportStatus(
  status: number,
  options: Pick<FetchOptionsV1, "adapter">,
): number {
  return browserResponseMetadata(options).responseMode ? 200 : status;
}

/** In envelope mode, target headers are data, never browser control instructions. */
export function browserEnvelopeHeaders(): Headers {
  return new Headers({
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
}
