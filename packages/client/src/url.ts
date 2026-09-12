import { targetUrlFromPath } from "@one-fetch/core";

export function parseServiceBaseUrl(value: string, label: string): URL {
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
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(`${label} cannot contain userinfo, query, or hash`);
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url;
}

export function serviceBaseUrl(value: string, label: string): string {
  const url = parseServiceBaseUrl(value, label);
  return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
}

export function buildServiceUrl(
  serviceUrl: string,
  pathAndQuery: string,
  label: string,
): URL {
  if (!pathAndQuery.startsWith("/")) {
    throw new TypeError("Service request path must start with /");
  }
  const service = parseServiceBaseUrl(serviceUrl, label);
  const route = targetUrlFromPath("https://route.invalid", pathAndQuery);
  if (route.hash !== "")
    throw new TypeError("Service path cannot contain a fragment");
  const basePath = service.pathname === "/" ? "" : service.pathname;
  service.pathname = `${basePath}${route.pathname}`;
  service.search = route.search;
  return service;
}

export function buildGatewayUrl(gatewayUrl: string, targetUrl: string): URL {
  const target = new URL(targetUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TypeError("HTTP Gateway requests require an HTTP(S) target");
  }
  if (target.hash !== "")
    throw new TypeError("Target URL cannot contain a fragment");
  return buildServiceUrl(
    gatewayUrl,
    `${target.pathname}${target.search}`,
    "Gateway URL",
  );
}
