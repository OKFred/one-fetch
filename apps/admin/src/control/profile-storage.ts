import type { InstanceProfile } from "./types";

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

function refreshKey(profileId: string): string {
  return `${REFRESH_PREFIX}${profileId}`;
}

export function readProfiles(): InstanceProfile[] {
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

export function readActiveProfileId(): string | null {
  return localStorage.getItem(ACTIVE_PROFILE_KEY);
}

export function persistProfiles(
  profiles: InstanceProfile[],
  activeProfileId: string | null,
): void {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  if (activeProfileId)
    localStorage.setItem(ACTIVE_PROFILE_KEY, activeProfileId);
  else localStorage.removeItem(ACTIVE_PROFILE_KEY);
}

export function readRefreshToken(profileId: string): StoredRefreshToken | null {
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

export function hasPersistentRefreshToken(profileId: string): boolean {
  return localStorage.getItem(refreshKey(profileId)) !== null;
}

export function storeRefreshToken(
  profileId: string,
  value: StoredRefreshToken,
  persistent: boolean,
): void {
  const target = persistent ? localStorage : sessionStorage;
  const other = persistent ? sessionStorage : localStorage;
  const key = refreshKey(profileId);
  other.removeItem(key);
  target.setItem(key, JSON.stringify(value));
}

export function clearRefreshToken(profileId: string): void {
  const key = refreshKey(profileId);
  sessionStorage.removeItem(key);
  localStorage.removeItem(key);
}
