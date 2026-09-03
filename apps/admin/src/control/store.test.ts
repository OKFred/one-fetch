import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useControlStore } from "./store";

const pair = {
  schemaVersion: 1,
  accessToken: "a".repeat(32),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: "r".repeat(32),
  refreshExpiresAt: "2030-02-01T00:00:00.000Z",
  sessionId: "session-1",
};

const config = {
  schemaVersion: 1,
  instanceId: "test-instance",
  version: "20300101T000000Z-1-abcd1234",
  updatedAt: "2030-01-01T00:00:00.000Z",
  controlGatewayPairId: "pair-1",
  revision: 0,
  gatewayPaused: false,
  policy: { schemaVersion: 1, mode: "allowlist", revision: 0, rules: [] },
};

function mockControl(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: URL | RequestInfo) => {
    const url =
      input instanceof URL
        ? input.href
        : typeof input === "string"
          ? input
          : input.url;
    if (url.endsWith("/api/v1/auth/login"))
      return Promise.resolve(Response.json(pair));
    if (url.endsWith("/api/v1/config"))
      return Promise.resolve(Response.json(config));
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("control session storage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setActivePinia(createPinia());
  });

  it("keeps access tokens in memory and refresh tokens in session by default", async () => {
    mockControl();
    const store = useControlStore();
    store.saveProfile({ name: "Test", controlUrl: "https://control.example" });
    expect(
      await store.login({
        username: "admin",
        password: "correct horse battery staple",
        totpCode: "123456",
        rememberDevice: false,
      }),
    ).toBe(true);
    expect(store.session?.accessToken).toBe(pair.accessToken);
    expect(sessionStorage.length).toBe(1);
    expect(Object.values(localStorage).join(" ")).not.toContain(
      pair.accessToken,
    );
    expect(Object.values(sessionStorage).join(" ")).toContain(
      pair.refreshToken,
    );
  });

  it("persists refresh only after remember-device opt in", async () => {
    mockControl();
    const store = useControlStore();
    store.saveProfile({ name: "Test", controlUrl: "https://control.example" });
    await store.login({
      username: "admin",
      password: "correct horse battery staple",
      rememberDevice: true,
    });
    expect(sessionStorage.length).toBe(0);
    expect(Object.values(localStorage).join(" ")).toContain(pair.refreshToken);
    expect(Object.values(localStorage).join(" ")).not.toContain(
      pair.accessToken,
    );
  });

  it("clears saved credentials when a profile endpoint changes", async () => {
    mockControl();
    const store = useControlStore();
    store.saveProfile({ name: "Test", controlUrl: "https://control.example" });
    await store.login({
      username: "admin",
      password: "correct horse battery staple",
      rememberDevice: true,
    });
    const id = store.profile!.id;
    store.saveProfile({ id, name: "Moved", controlUrl: "https://new.example" });
    expect(store.session).toBeNull();
    expect(Object.values(localStorage).join(" ")).not.toContain(
      pair.refreshToken,
    );
  });
});
