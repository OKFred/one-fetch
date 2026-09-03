export function parseServiceOrigin(value: string, label: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]")
    )
  ) {
    throw new TypeError(
      `${label} must use HTTPS (HTTP is allowed only for loopback development)`,
    );
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      `${label} must be an origin without userinfo, path, query, or hash`,
    );
  }
  return url;
}

export function buildGatewayUrl(gatewayOrigin: string, targetUrl: string): URL {
  const gateway = parseServiceOrigin(gatewayOrigin, "Gateway URL");
  const target = new URL(targetUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TypeError("HTTP Gateway requests require an HTTP(S) target");
  }
  if (target.hash !== "")
    throw new TypeError("Target URL cannot contain a fragment");
  gateway.pathname = target.pathname;
  gateway.search = target.search;
  return gateway;
}
