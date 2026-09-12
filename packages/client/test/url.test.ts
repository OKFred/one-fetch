import { describe, expect, it } from "vitest";

import {
  OneFetchGatewayClient,
  buildGatewayUrl,
  buildServiceUrl,
} from "../src/index.js";

const paths = [
  "/",
  "/v1/users?a=1&a=2",
  "//v1/users?a=1&a=2",
  "///v1///items?empty=&bare&&=value",
  "//user:password@other.example:8443/v1?x=1",
  "//[not-a-host]/items",
  "/v1/%2F%2f?x=%2f&x=+&x=%20",
  "/a//b?url=https://other.example//tail&x=1",
] as const;

describe.each([
  ["https://gateway.example", ""],
  [
    "https://project.supabase.co/functions/v1/one-fetch-gateway",
    "/functions/v1/one-fetch-gateway",
  ],
])("Gateway path preservation through %s", (gateway, prefix) => {
  it.each(paths)("preserves the target path and query %s", (pathAndQuery) => {
    const target = new URL(`https://target.example${pathAndQuery}`);
    const url = buildGatewayUrl(gateway, target.href);
    expect(url.origin).toBe(new URL(gateway).origin);
    expect(url.pathname).toBe(`${prefix}${target.pathname}`);
    expect(url.search).toBe(target.search);
    expect(url.username).toBe("");
    expect(url.password).toBe("");
  });
});

it("service paths cannot be reinterpreted as a scheme-relative authority", () => {
  const result = buildServiceUrl(
    "https://control.example/base",
    "//other.example/api/v1/health?x=1&x=2",
    "Control URL",
  );
  expect(result.href).toBe(
    "https://control.example/base//other.example/api/v1/health?x=1&x=2",
  );
});

it("rejects non-path routes, fragments and unsafe service bases", () => {
  expect(() =>
    buildServiceUrl(
      "https://gateway.example",
      "https://other.example/x",
      "Gateway",
    ),
  ).toThrow("must start with /");
  expect(() =>
    buildServiceUrl("https://gateway.example", "//v1/x#fragment", "Gateway"),
  ).toThrow("cannot contain a fragment");
  expect(() =>
    buildGatewayUrl(
      "https://user:password@gateway.example",
      "https://target.example//v1",
    ),
  ).toThrow("cannot contain userinfo");
});

it("executeHttp sends an authority-shaped path to the configured Gateway only", async () => {
  const received: string[] = [];
  const client = new OneFetchGatewayClient({
    gatewayUrl: "https://relay.example/functions/v1/one-fetch-gateway",
    token: "of_synthetic_url_test_token_long_enough",
    fetch: (input, init) => {
      received.push(new Request(input, init).url);
      return Promise.resolve(new Response("synthetic"));
    },
  });
  const result = await client.executeHttp({
    method: "GET",
    targetUrl: "https://target.example//other.example/v1?x=1&x=2",
  });
  expect(await result.response.text()).toBe("synthetic");
  expect(received).toEqual([
    "https://relay.example/functions/v1/one-fetch-gateway//other.example/v1?x=1&x=2",
  ]);
});
