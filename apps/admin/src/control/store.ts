import {
  CreateExecutionTokenRequestV1Schema,
  PolicySetV1Schema,
  type CreateExecutionTokenRequestV1,
} from "@one-fetch/protocol";
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { AdminControlApi, UnsupportedControlFeatureError } from "./api";
import type {
  AuditPage,
  BootstrapState,
  FeatureState,
  InstanceProfile,
  RuntimeConfiguration,
  SessionState,
} from "./types";

const PROFILES_KEY = "one-fetch.admin.profiles.v1";
const ACTIVE_PROFILE_KEY = "one-fetch.admin.active-profile.v1";
const REFRESH_PREFIX = "one-fetch.admin.refresh.v1.";

interface StoredRefreshToken {
  token: string;
  expiresAt: string;
}

function isInstanceProfile(value: unknown): value is InstanceProfile {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Record<string, unknown>;
  return (
    typeof profile.id === "string" &&
    typeof profile.name === "string" &&
    typeof profile.controlUrl === "string"
  );
}

function readProfiles(): InstanceProfile[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(PROFILES_KEY) ?? "[]",
    );
    if (!Array.isArray(value)) return [];
    return value.filter(isInstanceProfile);
  } catch {
    return [];
  }
}

function refreshKey(profileId: string): string {
  return `${REFRESH_PREFIX}${profileId}`;
}

function readRefreshToken(profileId: string): StoredRefreshToken | null {
  for (const storage of [sessionStorage, localStorage]) {
    try {
      const value: unknown = JSON.parse(
        storage.getItem(refreshKey(profileId)) ?? "null",
      );
      if (
        typeof value === "object" &&
        value !== null &&
        "token" in value &&
        "expiresAt" in value &&
        typeof value.token === "string" &&
        typeof value.expiresAt === "string" &&
        new Date(value.expiresAt).getTime() > Date.now()
      ) {
        return value as StoredRefreshToken;
      }
    } catch {
      // Ignore corrupt browser storage and require a new login.
    }
  }
  return null;
}

export const useControlStore = defineStore("control", () => {
  const profiles = ref<InstanceProfile[]>(readProfiles());
  const savedActiveId = localStorage.getItem(ACTIVE_PROFILE_KEY);
  const activeProfileId = ref<string | null>(
    profiles.value.some(({ id }) => id === savedActiveId)
      ? savedActiveId
      : (profiles.value[0]?.id ?? null),
  );
  const api = shallowRef<AdminControlApi | null>(null);
  const capabilities = shallowRef<Awaited<
    ReturnType<AdminControlApi["capabilities"]>
  > | null>(null);
  const bootstrap = ref<BootstrapState | null>(null);
  const configuration = shallowRef<RuntimeConfiguration | null>(null);
  const tokens = ref<Awaited<ReturnType<AdminControlApi["listTokens"]>>>([]);
  const audit = ref<AuditPage>({ events: [] });
  const session = ref<SessionState | null>(null);
  const busy = ref(false);
  const error = ref("");
  const notice = ref("");
  const features = ref<Record<string, FeatureState>>({});

  const profile = computed(
    () => profiles.value.find(({ id }) => id === activeProfileId.value) ?? null,
  );
  const authenticated = computed(() => session.value !== null);
  const connected = computed(() => capabilities.value !== null);

  function persistProfiles(): void {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles.value));
    if (activeProfileId.value)
      localStorage.setItem(ACTIVE_PROFILE_KEY, activeProfileId.value);
    else localStorage.removeItem(ACTIVE_PROFILE_KEY);
  }

  function activateClient(): AdminControlApi {
    if (!profile.value) throw new Error("Control URL is not configured");
    const client = new AdminControlApi(
      profile.value.controlUrl,
      session.value?.accessToken,
    );
    api.value = client;
    return client;
  }

  function saveProfile(
    input: Omit<InstanceProfile, "id"> & { id?: string },
  ): void {
    void new AdminControlApi(input.controlUrl);
    const normalizedUrl = input.controlUrl.replace(/\/+$/u, "");
    const next: InstanceProfile = {
      id: input.id ?? crypto.randomUUID(),
      name: input.name.trim() || "one-fetch",
      controlUrl: normalizedUrl,
    };
    const index = profiles.value.findIndex(({ id }) => id === next.id);
    const endpointChanged =
      index >= 0 && profiles.value[index]?.controlUrl !== normalizedUrl;
    if (endpointChanged) {
      sessionStorage.removeItem(refreshKey(next.id));
      localStorage.removeItem(refreshKey(next.id));
      clearMemoryState();
    }
    if (index === -1) profiles.value.push(next);
    else profiles.value[index] = next;
    if (activeProfileId.value !== next.id) clearMemoryState();
    activeProfileId.value = next.id;
    persistProfiles();
    activateClient();
  }

  function selectProfile(id: string): void {
    if (!profiles.value.some((item) => item.id === id)) return;
    if (activeProfileId.value !== id) clearMemoryState();
    activeProfileId.value = id;
    persistProfiles();
    activateClient();
  }

  function deleteProfile(id: string): void {
    sessionStorage.removeItem(refreshKey(id));
    localStorage.removeItem(refreshKey(id));
    profiles.value = profiles.value.filter((item) => item.id !== id);
    if (activeProfileId.value === id) {
      clearMemoryState();
      activeProfileId.value = profiles.value[0]?.id ?? null;
      if (activeProfileId.value) activateClient();
    }
    persistProfiles();
  }

  function clearMemoryState(): void {
    api.value = null;
    capabilities.value = null;
    bootstrap.value = null;
    configuration.value = null;
    tokens.value = [];
    audit.value = { events: [] };
    session.value = null;
    features.value = {};
    error.value = "";
    notice.value = "";
  }

  async function initialize(): Promise<void> {
    if (!profile.value) return;
    activateClient();
    await refreshPublic();
    await restoreSession();
  }

  async function refreshPublic(): Promise<void> {
    await run(
      async () => {
        const client = api.value ?? activateClient();
        capabilities.value = await client.capabilities();
        bootstrap.value = await client.bootstrapStatus();
        if (authenticated.value) await loadConfiguration();
      },
      false,
      false,
    );
  }

  async function restoreSession(): Promise<void> {
    if (!profile.value || session.value) return;
    const stored = readRefreshToken(profile.value.id);
    if (!stored) return;
    await run(
      async () => {
        const pair = await (api.value ?? activateClient()).refresh(
          stored.token,
        );
        const persisted =
          localStorage.getItem(refreshKey(profile.value!.id)) !== null;
        applySession(pair, persisted);
        await loadConfiguration();
      },
      true,
      false,
    );
  }

  async function login(input: {
    username: string;
    password: string;
    totpCode?: string;
    recoveryCode?: string;
    rememberDevice: boolean;
  }): Promise<boolean> {
    const result = await run(
      async () => {
        const pair = await (api.value ?? activateClient()).login({
          schemaVersion: 1,
          username: input.username,
          password: input.password,
          rememberDevice: input.rememberDevice,
          deviceFingerprint: crypto.randomUUID(),
          ...(input.totpCode ? { totpCode: input.totpCode } : {}),
          ...(input.recoveryCode ? { recoveryCode: input.recoveryCode } : {}),
        });
        applySession(pair, input.rememberDevice);
        await loadConfiguration();
        return true;
      },
      false,
      false,
    );
    return result === true;
  }

  async function createAdministrator(input: {
    bootstrapSecret: string;
    username: string;
    password: string;
  }): Promise<boolean> {
    const result = await run(
      async () => {
        const pair = await (api.value ?? activateClient()).bootstrap(input);
        bootstrap.value = { initialized: true, supported: true };
        if (pair) applySession(pair, false);
        notice.value = pair
          ? "Administrator created and signed in."
          : "Administrator created. Sign in to continue.";
        return true;
      },
      false,
      false,
    );
    return result === true;
  }

  function applySession(
    pair: Awaited<ReturnType<AdminControlApi["login"]>>,
    rememberDevice: boolean,
  ): void {
    session.value = {
      accessToken: pair.accessToken,
      accessExpiresAt: pair.accessExpiresAt,
      refreshExpiresAt: pair.refreshExpiresAt,
      ...(pair.sessionId ? { sessionId: pair.sessionId } : {}),
    };
    api.value?.setAccessToken(pair.accessToken);
    if (!profile.value) return;
    const key = refreshKey(profile.value.id);
    const target = rememberDevice ? localStorage : sessionStorage;
    const other = rememberDevice ? sessionStorage : localStorage;
    other.removeItem(key);
    target.setItem(
      key,
      JSON.stringify({
        token: pair.refreshToken,
        expiresAt: pair.refreshExpiresAt,
      }),
    );
  }

  function logout(): void {
    if (profile.value) {
      sessionStorage.removeItem(refreshKey(profile.value.id));
      localStorage.removeItem(refreshKey(profile.value.id));
    }
    session.value = null;
    configuration.value = null;
    tokens.value = [];
    audit.value = { events: [] };
    api.value?.setAccessToken(undefined);
  }

  async function loadConfiguration(): Promise<void> {
    configuration.value = await requireApi().configuration();
  }

  async function savePolicy(policy: unknown): Promise<boolean> {
    const result = await run(
      async () => {
        if (!configuration.value) await loadConfiguration();
        configuration.value = await requireApi().savePolicy(
          configuration.value!,
          PolicySetV1Schema.parse(policy),
        );
        if (capabilities.value) {
          capabilities.value = {
            ...capabilities.value,
            configVersion: configuration.value.version,
            configUpdatedAt: configuration.value.updatedAt,
            policyMode: configuration.value.policy.mode,
          };
        }
        notice.value = "Policy published.";
        return true;
      },
      false,
      false,
    );
    return result === true;
  }

  async function setGatewayPaused(paused: boolean): Promise<boolean> {
    return runFeature("gateway-pause", async () => {
      if (!configuration.value) await loadConfiguration();
      configuration.value = await requireApi().setGatewayPaused(
        configuration.value!,
        paused,
      );
      notice.value = paused ? "Gateway paused." : "Gateway resumed.";
    });
  }

  async function loadTokens(): Promise<boolean> {
    return runFeature("tokens", async () => {
      tokens.value = await requireApi().listTokens();
    });
  }

  async function createToken(input: CreateExecutionTokenRequestV1) {
    let created: Awaited<ReturnType<AdminControlApi["createToken"]>> | null =
      null;
    const ok = await runFeature("tokens", async () => {
      created = await requireApi().createToken(
        CreateExecutionTokenRequestV1Schema.parse(input),
      );
      await loadTokens();
    });
    return ok ? created : null;
  }

  async function revokeToken(id: string): Promise<boolean> {
    return runFeature("tokens", async () => {
      await requireApi().revokeToken(id);
      await loadTokens();
    });
  }

  async function loadAudit(cursor?: string): Promise<boolean> {
    return runFeature("audit", async () => {
      const page = await requireApi().auditPage(cursor);
      audit.value = cursor
        ? {
            events: [...audit.value.events, ...page.events],
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          }
        : page;
    });
  }

  async function exportAudit(): Promise<Blob | null> {
    let blob: Blob | null = null;
    const ok = await runFeature("audit-export", async () => {
      blob = await requireApi().exportAudit();
    });
    return ok ? blob : null;
  }

  async function invokeFeature(
    feature: string,
    path: `/api/v1/${string}`,
    init?: RequestInit,
  ): Promise<unknown> {
    let value: unknown = null;
    const ok = await runFeature(feature, async () => {
      value = await requireApi().requestFeature(path, init);
    });
    return ok ? value : null;
  }

  function requireApi(): AdminControlApi {
    return api.value ?? activateClient();
  }

  async function run<T>(
    task: () => Promise<T>,
    quiet = false,
    rethrow = true,
  ): Promise<T | false> {
    busy.value = true;
    if (!quiet) {
      error.value = "";
      notice.value = "";
    }
    try {
      return await task();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      if (rethrow) throw cause;
      return false;
    } finally {
      busy.value = false;
    }
  }

  async function runFeature(
    feature: string,
    task: () => Promise<void>,
  ): Promise<boolean> {
    const result = await run(
      async () => {
        try {
          await task();
          features.value[feature] = { available: true };
          return true;
        } catch (cause) {
          if (cause instanceof UnsupportedControlFeatureError) {
            features.value[feature] = {
              available: false,
              detail: cause.message,
            };
            return false;
          }
          throw cause;
        }
      },
      false,
      false,
    );
    return result === true;
  }

  return {
    profiles,
    activeProfileId,
    profile,
    capabilities,
    bootstrap,
    configuration,
    tokens,
    audit,
    session,
    busy,
    error,
    notice,
    features,
    authenticated,
    connected,
    saveProfile,
    selectProfile,
    deleteProfile,
    initialize,
    refreshPublic,
    login,
    logout,
    createAdministrator,
    loadConfiguration,
    savePolicy,
    setGatewayPaused,
    loadTokens,
    createToken,
    revokeToken,
    loadAudit,
    exportAudit,
    invokeFeature,
  };
});
