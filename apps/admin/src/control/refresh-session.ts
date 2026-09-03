import { SessionTokenPairV1Schema } from "@one-fetch/protocol";

import {
  clearRefreshToken,
  readRefreshToken,
  storeRefreshToken,
} from "./profile-storage";
import type { AdminSessionPair } from "./types";

const CHANNEL_PREFIX = "one-fetch.admin.refresh.v1.";
const CONSUMED_PREFIX = "one-fetch.admin.refresh-consumed.v1.";
const LOGIN_REQUIRED_MESSAGE =
  "Session refresh could not be confirmed. The old refresh token was discarded. Sign in again.";

type WithExclusiveLock = <T>(
  name: string,
  task: () => Promise<T>,
) => Promise<T>;

export interface RefreshChannel {
  close(): void;
  post(message: unknown): void;
  subscribe(listener: (message: unknown) => void): () => void;
}

export interface RefreshSessionEnvironment {
  digest(value: string): Promise<string>;
  openChannel(name: string): RefreshChannel | null;
  waitForMessageMs: number;
  withExclusiveLock: WithExclusiveLock | null;
}

interface RefreshResult {
  pair: AdminSessionPair;
  persistent: boolean;
}

interface ConsumedRefresh {
  expiresAt: string;
  state: "pending" | "succeeded" | "failed";
}

type RefreshMessage =
  | { pair: AdminSessionPair; scope: string; type: "succeeded" }
  | { scope: string; type: "failed" };

export class RefreshLoginRequiredError extends Error {
  constructor(options?: ErrorOptions) {
    super(LOGIN_REQUIRED_MESSAGE, options);
    this.name = "RefreshLoginRequiredError";
  }
}

function consumedKey(scope: string): string {
  return `${CONSUMED_PREFIX}${scope}`;
}

function wasConsumed(scope: string): boolean {
  const key = consumedKey(scope);
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return true;
  }
  if (raw === null) return false;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("expiresAt" in value) ||
      !("state" in value) ||
      typeof value.expiresAt !== "string" ||
      !["pending", "succeeded", "failed"].includes(String(value.state))
    ) {
      return true;
    }
    if (new Date(value.expiresAt).getTime() <= Date.now()) {
      localStorage.removeItem(key);
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function writeConsumed(
  scope: string,
  expiresAt: string,
  state: ConsumedRefresh["state"],
): void {
  localStorage.setItem(
    consumedKey(scope),
    JSON.stringify({ expiresAt, state }),
  );
}

function parseMessage(value: unknown, scope: string): RefreshMessage | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("scope" in value) ||
    value.scope !== scope ||
    !("type" in value)
  ) {
    return null;
  }
  if (value.type === "failed") return { scope, type: "failed" };
  if (value.type !== "succeeded" || !("pair" in value)) return null;
  const pair = SessionTokenPairV1Schema.safeParse(value.pair);
  return pair.success ? { pair: pair.data, scope, type: "succeeded" } : null;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function browserEnvironment(): RefreshSessionEnvironment {
  const lockManager =
    typeof navigator === "undefined" ? undefined : navigator.locks;
  const withExclusiveLock: WithExclusiveLock | null = lockManager
    ? async (name, task) =>
        await lockManager.request(name, { mode: "exclusive" }, () => task())
    : null;
  return {
    digest: sha256,
    openChannel: (name) => {
      if (typeof BroadcastChannel === "undefined") return null;
      const channel = new BroadcastChannel(name);
      return {
        close: () => channel.close(),
        post: (message) => channel.postMessage(message),
        subscribe: (listener) => {
          const receive = (event: MessageEvent<unknown>) =>
            listener(event.data);
          channel.addEventListener("message", receive);
          return () => channel.removeEventListener("message", receive);
        },
      };
    },
    waitForMessageMs: 500,
    withExclusiveLock,
  };
}

function loginRequired(cause?: unknown): RefreshLoginRequiredError {
  return new RefreshLoginRequiredError(
    cause === undefined ? undefined : { cause },
  );
}

export async function refreshSession(
  profileId: string,
  refresh: (token: string) => Promise<AdminSessionPair>,
  environment: RefreshSessionEnvironment = browserEnvironment(),
): Promise<RefreshResult | null> {
  const stored = readRefreshToken(profileId);
  if (!stored) return null;
  const { persistent } = stored;

  let scope: string;
  try {
    scope = await environment.digest(`${profileId}\0${stored.token}`);
  } catch (cause) {
    clearRefreshToken(profileId);
    throw loginRequired(cause);
  }

  if (!environment.withExclusiveLock) {
    clearRefreshToken(profileId);
    throw loginRequired(new Error("Web Locks API is unavailable"));
  }

  let channel: RefreshChannel | null = null;
  let observed: RefreshMessage | null = null;
  let wake: (() => void) | undefined;
  try {
    channel = environment.openChannel(`${CHANNEL_PREFIX}${scope}`);
  } catch (cause) {
    clearRefreshToken(profileId);
    throw loginRequired(cause);
  }
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = channel?.subscribe((value) => {
      const message = parseMessage(value, scope);
      if (!message) return;
      observed = message;
      wake?.();
    });
  } catch (cause) {
    channel?.close();
    clearRefreshToken(profileId);
    throw loginRequired(cause);
  }

  const publish = (message: RefreshMessage): void => {
    try {
      channel?.post(message);
    } catch {
      // A missing handoff makes peers fail closed; it must not undo this result.
    }
  };

  const waitForMessage = async (): Promise<RefreshMessage | null> => {
    if (observed || !channel) return observed;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, environment.waitForMessageMs);
      wake = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    wake = undefined;
    return observed;
  };

  const joinCompletedRefresh = async (): Promise<RefreshResult> => {
    const outcome = observed ?? (await waitForMessage());
    if (outcome?.type === "succeeded") {
      storeRefreshToken(
        profileId,
        {
          expiresAt: outcome.pair.refreshExpiresAt,
          token: outcome.pair.refreshToken,
        },
        persistent,
      );
      return { pair: outcome.pair, persistent };
    }
    clearRefreshToken(profileId);
    throw loginRequired();
  };

  try {
    return await environment.withExclusiveLock(
      `${CHANNEL_PREFIX}${scope}`,
      async () => {
        if (wasConsumed(scope)) return joinCompletedRefresh();

        writeConsumed(scope, stored.expiresAt, "pending");
        clearRefreshToken(profileId);
        try {
          const pair = await refresh(stored.token);
          storeRefreshToken(
            profileId,
            { expiresAt: pair.refreshExpiresAt, token: pair.refreshToken },
            persistent,
          );
          writeConsumed(scope, stored.expiresAt, "succeeded");
          publish({ pair, scope, type: "succeeded" });
          return { pair, persistent };
        } catch (cause) {
          try {
            writeConsumed(scope, stored.expiresAt, "failed");
            publish({ scope, type: "failed" });
          } catch {
            // The old token was cleared before the request and stays unusable.
          }
          throw loginRequired(cause);
        }
      },
    );
  } catch (cause) {
    clearRefreshToken(profileId);
    if (cause instanceof RefreshLoginRequiredError) throw cause;
    throw loginRequired(cause);
  } finally {
    unsubscribe?.();
    channel?.close();
  }
}
