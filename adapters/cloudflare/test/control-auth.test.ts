import { SELF } from "cloudflare:test";
import {
  ChangePasswordResponseV1Schema,
  LogoutResponseV1Schema,
  SessionListV1Schema,
  SessionRevokeResponseV1Schema,
  SessionTokenPairV1Schema,
  TotpEnableResponseV1Schema,
  TotpPrepareResponseV1Schema,
} from "@one-fetch/protocol";
import { describe, expect, it } from "vitest";

import { generateTotp } from "../src/totp";
import {
  authorizedRequest,
  bootstrapAdmin,
  bootstrapBody,
  expectControlError,
  jsonRequest,
  loginAdmin,
} from "./control-fixtures";

describe("Cloudflare canonical administrator authentication", () => {
  it("lists, revokes, and logs out sessions with canonical records", async () => {
    const first = await bootstrapAdmin();
    const current = await loginAdmin();
    const sessions = SessionListV1Schema.parse(
      await (
        await authorizedRequest(current.accessToken, "/api/v1/auth/sessions")
      ).json(),
    );
    expect(sessions.sessions).toHaveLength(2);
    expect(sessions.sessions.find(({ current }) => current)?.id).toBe(
      current.sessionId,
    );

    const revoked = SessionRevokeResponseV1Schema.parse(
      await (
        await authorizedRequest(
          current.accessToken,
          `/api/v1/auth/sessions/${first.sessionId}`,
          { method: "DELETE" },
        )
      ).json(),
    );
    expect(revoked.sessionId).toBe(first.sessionId);

    const logout = LogoutResponseV1Schema.parse(
      await (
        await authorizedRequest(current.accessToken, "/api/v1/auth/logout", {
          method: "POST",
        })
      ).json(),
    );
    expect(logout.sessionId).toBe(current.sessionId);
    await expectControlError(
      await authorizedRequest(current.accessToken, "/api/v1/auth/sessions"),
      401,
      "unauthorized",
    );
  });

  it("rotates refresh credentials and rejects family reuse", async () => {
    const initial = await bootstrapAdmin();
    const refreshedResponse = await jsonRequest("/api/v1/auth/refresh", {
      schemaVersion: 1,
      refreshToken: initial.refreshToken,
    });
    expect(refreshedResponse.status).toBe(200);
    const refreshed = SessionTokenPairV1Schema.parse(
      await refreshedResponse.json(),
    );
    expect(refreshed.sessionId).toBe(initial.sessionId);
    expect(refreshed.refreshToken).not.toBe(initial.refreshToken);
    await expectControlError(
      await authorizedRequest(initial.accessToken, "/api/v1/auth/sessions"),
      401,
      "unauthorized",
    );
    await expectControlError(
      await jsonRequest("/api/v1/auth/refresh", {
        schemaVersion: 1,
        refreshToken: initial.refreshToken,
      }),
      401,
      "invalid_refresh_token",
    );
    await expectControlError(
      await authorizedRequest(refreshed.accessToken, "/api/v1/auth/sessions"),
      401,
      "unauthorized",
    );
  });

  it("enables TOTP and issues recovery codes only after verification", async () => {
    const pair = await bootstrapAdmin();
    const prepared = TotpPrepareResponseV1Schema.parse(
      await (
        await authorizedRequest(pair.accessToken, "/api/v1/auth/totp/prepare", {
          method: "POST",
        })
      ).json(),
    );
    const code = await generateTotp(
      prepared.secret,
      Math.floor(Date.now() / 30_000),
    );
    const enabled = TotpEnableResponseV1Schema.parse(
      await (
        await authorizedRequest(pair.accessToken, "/api/v1/auth/totp/enable", {
          method: "POST",
          body: { schemaVersion: 1, code },
        })
      ).json(),
    );
    expect(enabled.recoveryCodes).toHaveLength(10);

    await expectControlError(
      await jsonRequest("/api/v1/auth/login", {
        schemaVersion: 1,
        username: bootstrapBody.username,
        password: bootstrapBody.password,
        rememberDevice: false,
      }),
      428,
      "totp_required",
    );
    const recovered = SessionTokenPairV1Schema.parse(
      await (
        await jsonRequest("/api/v1/auth/login", {
          schemaVersion: 1,
          username: bootstrapBody.username,
          password: bootstrapBody.password,
          recoveryCode: enabled.recoveryCodes[0],
          rememberDevice: false,
        })
      ).json(),
    );
    expect(recovered.accessToken).toBeTruthy();
    await expectControlError(
      await jsonRequest("/api/v1/auth/login", {
        schemaVersion: 1,
        username: bootstrapBody.username,
        password: bootstrapBody.password,
        recoveryCode: enabled.recoveryCodes[0],
        rememberDevice: false,
      }),
      401,
      "invalid_totp",
    );
  });

  it("changes the password and revokes every other active session", async () => {
    const first = await bootstrapAdmin();
    const current = await loginAdmin();
    const newPassword = "new correct horse battery staple";
    const changed = ChangePasswordResponseV1Schema.parse(
      await (
        await authorizedRequest(current.accessToken, "/api/v1/auth/password", {
          method: "POST",
          body: {
            schemaVersion: 1,
            currentPassword: bootstrapBody.password,
            newPassword,
          },
        })
      ).json(),
    );
    expect(changed.revokedSessionIds).toEqual([first.sessionId]);
    const sessions = SessionListV1Schema.parse(
      await (
        await authorizedRequest(current.accessToken, "/api/v1/auth/sessions")
      ).json(),
    );
    expect(sessions.sessions).toEqual([
      expect.objectContaining({ current: true, id: current.sessionId }),
    ]);
    await expectControlError(
      await jsonRequest("/api/v1/auth/login", {
        schemaVersion: 1,
        username: bootstrapBody.username,
        password: bootstrapBody.password,
        rememberDevice: false,
      }),
      401,
      "invalid_credentials",
    );
    const loggedIn = await jsonRequest("/api/v1/auth/login", {
      schemaVersion: 1,
      username: bootstrapBody.username,
      password: newPassword,
      rememberDevice: false,
    });
    expect(loggedIn.status).toBe(200);
    expect(
      SessionTokenPairV1Schema.parse(await loggedIn.json()).accessToken,
    ).toBeTruthy();
  });

  it("rejects unknown resources with a canonical error", async () => {
    await expectControlError(
      await SELF.fetch("https://control.example/api/v1/does-not-exist"),
      404,
      "not_found",
    );
  });
});
