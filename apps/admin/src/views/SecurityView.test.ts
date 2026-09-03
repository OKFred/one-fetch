import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useControlStore } from "../store";
import SecurityView from "./SecurityView.vue";

const messages = {
  en: {
    common: { reload: "Reload" },
    signIn: "Sign in",
    authenticate: "Authenticate",
    securityUi: {
      sessions: "Device sessions",
      sessionsHint: "Review sessions",
      current: "Current",
      active: "Active",
      created: "Created",
      lastSeen: "Last seen",
      expires: "Expires",
      revoke: "Revoke",
      revokeConfirm: "Revoke session?",
      noSessions: "No sessions",
      totp: "Two-factor authentication",
      totpHint: "Configure TOTP",
      prepareTotp: "Set up authenticator",
      scan: "Scan",
      manualSecret: "Secret",
      verificationCode: "Code",
      enableTotp: "Enable",
      recoveryTitle: "Recovery codes",
      recoveryHint: "Shown once",
      copyCodes: "Copy codes",
      savedCodes: "Saved",
      password: "Change password",
      passwordHint: "Password hint",
      currentPassword: "Current password",
      newPassword: "New password",
      confirmPassword: "Confirm password",
      changePassword: "Change password",
      mismatch: "Passwords do not match",
      samePassword: "Password must change",
    },
  },
};

function mountView() {
  return mount(SecurityView, {
    global: {
      plugins: [createI18n({ legacy: false, locale: "en", messages })],
    },
  });
}

describe("account security", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setActivePinia(createPinia());
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
  });

  it("lists and revokes a non-current device session", async () => {
    const store = useControlStore();
    store.session = {
      accessToken: "a".repeat(32),
      accessExpiresAt: "2030-01-01T00:15:00.000Z",
      refreshExpiresAt: "2030-02-01T00:00:00.000Z",
    };
    store.securitySessions = [
      {
        schemaVersion: 1,
        id: "session-other",
        createdAt: "2030-01-01T00:00:00.000Z",
        lastSeenAt: "2030-01-01T00:05:00.000Z",
        expiresAt: "2030-02-01T00:00:00.000Z",
        current: false,
        deviceFingerprint: "browser-a1b2",
      },
    ];
    vi.spyOn(store, "loadSecuritySessions").mockResolvedValue(true);
    const revoke = vi
      .spyOn(store, "revokeSecuritySession")
      .mockResolvedValue(true);

    const wrapper = mountView();
    await wrapper.get(".session-row button").trigger("click");

    expect(wrapper.text()).toContain("browser-a1b2");
    expect(revoke).toHaveBeenCalledWith("session-other");
  });

  it("renders a local QR image and clears setup secrets on unmount", async () => {
    const store = useControlStore();
    store.session = {
      accessToken: "a".repeat(32),
      accessExpiresAt: "2030-01-01T00:15:00.000Z",
      refreshExpiresAt: "2030-02-01T00:00:00.000Z",
    };
    store.totpPreparation = {
      schemaVersion: 1,
      secret: "JBSWY3DPEHPK3PXP",
      otpauthUri:
        "otpauth://totp/one-fetch:admin?secret=JBSWY3DPEHPK3PXP&issuer=one-fetch",
    };
    store.recoveryCodes = ["RECOVERY-ONE"];
    vi.spyOn(store, "loadSecuritySessions").mockResolvedValue(true);

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.get(".totp-setup img").attributes("src")).toMatch(
      /^data:image\/svg\+xml/u,
    );
    wrapper.unmount();
    expect(store.totpPreparation).toBeNull();
    expect(store.recoveryCodes).toEqual([]);
  });
});
