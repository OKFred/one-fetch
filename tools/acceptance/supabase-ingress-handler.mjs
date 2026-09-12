// A temporary, authenticated diagnostic; no upstream fetch, storage or logging.
export const INGRESS_PROBE_CASES = Object.freeze([
  ["plain", "/echo?value=hello"],
  ["space", "/echo?value=hello%20world"],
  ["plus", "/echo?value=hello+world"],
  ["encoded-plus", "/echo?value=hello%2bworld"],
  ["mixed", "/echo?x=hello%20world&x=hello+world&x=%2b&x=%2B"],
  ["slashes", "///echo?x=%2f&x=%2F"],
  ["path-space", "/hello%20world?x=1"],
  ["encoded-percent", "/echo?x=%2520&x=%252b"],
  ["reserved", "/echo?x=%26%3d%3f%23%2f%3b%3a%40%24%2c"],
  ["unreserved", "/echo?x=%41%7e%2d%5f%2e"],
  ["empty-duplicate", "/echo?x=&x=two&empty&x=three"],
  ["unicode", "/echo?x=%e4%b8%ad%e6%96%87"],
  [
    "encoded-ascii",
    "/echo?x=%41%5a%61%7a%30%39%2d%5f%2e%7e%21%2a%27%28%29%5b%5d",
  ],
  ["literal-punctuation", "/echo?x=~!*%27()[]:@$,;/"],
  ["query-keys", "/echo?hello%20world=1&hello+world=2&plus%2b=3&%41=4"],
  ["path-unreserved", "/%41%7e%2d%5f%2e?x=1"],
]);

export function createIngressProbeHandler(options) {
  if (
    !/^one-fetch-ingress-[a-f0-9]{16,32}$/u.test(options.functionName) ||
    !/^[a-f0-9]{64}$/u.test(options.tokenSha256) ||
    !Number.isSafeInteger(options.expiresAt)
  )
    throw new TypeError("Invalid ingress probe configuration");
  const cases = new Set(INGRESS_PROBE_CASES.map(([id]) => id));
  const respond = (value, status = 200) =>
    globalThis.Response.json(value, {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  return async (request) => {
    if (Date.now() >= options.expiresAt)
      return respond({ error: "expired" }, 410);
    if (request.method !== "GET" || request.body !== null)
      return respond({ error: "unsupported_request" }, 405);
    const token = request.headers.get("one-fetch-probe-token") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token))
      return respond({ error: "unauthorized" }, 401);
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest(
        "SHA-256",
        new globalThis.TextEncoder().encode(token),
      ),
    );
    let difference = 0;
    for (let i = 0; i < digest.length; i += 1)
      difference |=
        digest[i] ^
        Number.parseInt(options.tokenSha256.slice(i * 2, i * 2 + 2), 16);
    if (difference !== 0) return respond({ error: "unauthorized" }, 401);
    const caseId = request.headers.get("one-fetch-probe-case");
    if (!cases.has(caseId) || request.url.length > 4096)
      return respond({ error: "invalid_case" }, 400);
    const url = new globalThis.URL(request.url);
    const marker = `/${options.functionName}`;
    const index = url.pathname.indexOf(marker);
    if (index < 0 || !url.pathname.slice(index + marker.length).startsWith("/"))
      return respond({ error: "invalid_path" }, 400);
    const path = url.pathname.slice(index + marker.length);
    // Raw request spelling is useful if constructing URL itself changes it.
    const rawStart = request.url.indexOf(marker) + marker.length;
    return respond({
      schemaVersion: 1,
      functionName: options.functionName,
      caseId,
      rawPathAndQuery: request.url.slice(rawStart),
      pathname: path,
      search: url.search,
    });
  };
}
