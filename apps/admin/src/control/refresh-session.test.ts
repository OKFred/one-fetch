import { beforeEach, describe, expect, it, vi } from "vitest";

import { readRefreshToken, storeRefreshToken } from "./profile-storage";
import {
  refreshSession,
  RefreshLoginRequiredError,
  type RefreshChannel,
  type RefreshSessionEnvironment,
} from "./refresh-session";

const profileId = "profile-1";
const oldRefresh = "o".repeat(32);
const pair = {
  schemaVersion: 1 as const,
  accessToken: "a".repeat(32),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: "n".repeat(32),
  refreshExpiresAt: "2030-02-01T00:00:00.000Z",
  sessionId: "session-1",
};

class ExclusiveLocks {
  readonly names: string[] = [];
  readonly #tails = new Map<string, Promise<void>>();

  readonly request = async <T>(
    name: string,
    task: () => Promise<T>,
  ): Promise<T> => {
    this.names.push(name);
    const predecessor = this.#tails.get(name) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => current);
    this.#tails.set(name, tail);
    await predecessor;
    try {
      return await task();
    } finally {
      release();
      if (this.#tails.get(name) === tail) this.#tails.delete(name);
    }
  };
}

class BroadcastHub {
  readonly #listeners = new Map<string, Set<(message: unknown) => void>>();

  readonly open = (name: string): RefreshChannel => {
    const listeners = this.#listeners.get(name) ?? new Set();
    this.#listeners.set(name, listeners);
    const owned = new Set<(message: unknown) => void>();
    return {
      close: () => {
        for (const listener of owned) listeners.delete(listener);
      },
      post: (message) => {
        for (const listener of listeners) {
          if (!owned.has(listener)) {
            queueMicrotask(() => listener(structuredClone(message)));
          }
        }
      },
      subscribe: (listener) => {
        owned.add(listener);
        listeners.add(listener);
        return () => {
          owned.delete(listener);
          listeners.delete(listener);
        };
      },
    };
  };
}

function environment(
  locks: ExclusiveLocks,
  hub: BroadcastHub | null = new BroadcastHub(),
): RefreshSessionEnvironment {
  return {
    digest: () => Promise.resolve("refresh-token-scope"),
    openChannel: hub ? hub.open : () => null,
    waitForMessageMs: 20,
    withExclusiveLock: locks.request,
  };
}

function saveOldRefresh(persistent = true): void {
  storeRefreshToken(
    profileId,
    { expiresAt: "2030-02-01T00:00:00.000Z", token: oldRefresh },
    persistent,
  );
}

describe("cross-tab refresh rotation", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("joins concurrent tabs to one refresh request", async () => {
    saveOldRefresh();
    const locks = new ExclusiveLocks();
    const hub = new BroadcastHub();
    let finishRefresh = (): void => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const refresh = vi.fn(async (token: string) => {
      expect(token).toBe(oldRefresh);
      await refreshGate;
      return pair;
    });

    const first = refreshSession(profileId, refresh, environment(locks, hub));
    const second = refreshSession(profileId, refresh, environment(locks, hub));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    finishRefresh();

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result?.pair)).toEqual([pair, pair]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(new Set(locks.names).size).toBe(1);
    expect(readRefreshToken(profileId)?.token).toBe(pair.refreshToken);
  });

  it("discards the old token when the network result is unknown", async () => {
    saveOldRefresh();
    const refresh = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const runtime = environment(new ExclusiveLocks());

    let failure: unknown;
    try {
      await refreshSession(profileId, refresh, runtime);
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(RefreshLoginRequiredError);
    expect((failure as Error).message).toMatch(/discarded.*Sign in again/u);
    expect(readRefreshToken(profileId)).toBeNull();
    await expect(
      refreshSession(profileId, refresh, runtime),
    ).resolves.toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("never replays a consumed token when the broadcast was missed", async () => {
    saveOldRefresh(false);
    const refresh = vi.fn().mockResolvedValue(pair);
    const runtime = environment(new ExclusiveLocks(), null);
    await refreshSession(profileId, refresh, runtime);

    saveOldRefresh(false);
    await expect(
      refreshSession(profileId, refresh, runtime),
    ).rejects.toBeInstanceOf(RefreshLoginRequiredError);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(readRefreshToken(profileId)).toBeNull();
  });

  it("fails closed when cross-tab locking is unavailable", async () => {
    saveOldRefresh();
    const refresh = vi.fn().mockResolvedValue(pair);
    const runtime: RefreshSessionEnvironment = {
      ...environment(new ExclusiveLocks()),
      withExclusiveLock: null,
    };

    await expect(
      refreshSession(profileId, refresh, runtime),
    ).rejects.toBeInstanceOf(RefreshLoginRequiredError);
    expect(refresh).not.toHaveBeenCalled();
    expect(readRefreshToken(profileId)).toBeNull();
  });
});
