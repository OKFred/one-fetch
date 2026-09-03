import {
  encodeBase32,
  generateTotpSecret,
  openSecret,
  sealSecret,
  verifyTotpCode,
} from "@one-fetch/core";
import type {
  TotpEnableResponseV1,
  TotpPrepareResponseV1,
} from "@one-fetch/protocol";

import type { AuditLedger } from "./audit.js";
import { hmacSha256Hex, randomId, randomToken } from "./crypto.js";
import type { DatabaseClient } from "./database.js";
import type { SqlOperation } from "./database-protocol.js";

interface AdministratorFactorRow {
  id: string;
  pending_totp_ciphertext: string | null;
  totp_ciphertext: string | null;
  username: string;
}

export interface SecondFactorInput {
  recoveryCode?: string;
  totpCode?: string;
}

export type SecondFactorResult = "accepted" | "invalid" | "required";

const normalizeRecoveryCode = (value: string): string =>
  value.replaceAll(/[^A-Za-z0-9]/gu, "").toUpperCase();

const createRecoveryCodes = (count = 10): string[] =>
  Array.from({ length: count }, () => {
    const value = normalizeRecoveryCode(randomToken(9))
      .padEnd(12, "X")
      .slice(0, 12);
    return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
  });

export class SecondFactorService {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly database: DatabaseClient,
    private readonly audit: AuditLedger,
    private readonly pepper: string,
  ) {}

  async verify(
    administratorId: string,
    encryptedSecret: string | null,
    input: SecondFactorInput,
  ): Promise<SecondFactorResult> {
    if (!encryptedSecret) return "accepted";
    if (!input.totpCode && !input.recoveryCode) return "required";
    if (input.totpCode) {
      try {
        const secret = await openSecret(
          encryptedSecret,
          this.pepper,
          this.#context(administratorId),
        );
        return (await verifyTotpCode(secret, input.totpCode, { window: 1 }))
          ? "accepted"
          : "invalid";
      } catch {
        return "invalid";
      }
    }
    const digest = this.#recoveryDigest(input.recoveryCode!);
    const result = await this.database.run(
      `UPDATE recovery_codes SET used_at = ?
       WHERE administrator_id = ? AND digest = ? AND used_at IS NULL`,
      [new Date().toISOString(), administratorId, digest],
    );
    return result.changes === 1 ? "accepted" : "invalid";
  }

  async prepare(administratorId: string): Promise<TotpPrepareResponseV1> {
    return this.#exclusive(async () => {
      const administrator = await this.#administrator(administratorId);
      if (!administrator) throw new Error("Administrator was not found");
      const secret = generateTotpSecret();
      const encoded = encodeBase32(secret);
      const encrypted = await sealSecret(
        secret,
        this.pepper,
        this.#context(administratorId),
      );
      const now = new Date().toISOString();
      await this.database.transaction([
        {
          kind: "run",
          parameters: [encrypted, now, administratorId],
          sql: "UPDATE administrators SET pending_totp_ciphertext = ?, updated_at = ? WHERE id = ?",
        },
        this.audit.prepare({
          action: "auth.totp.prepare",
          actor: { actorId: administratorId, type: "admin" },
          category: "security",
          correlation: {},
          outcome: "success",
          severity: "warning",
        }).operation,
      ]);
      const label = encodeURIComponent(`one-fetch:${administrator.username}`);
      return {
        otpauthUri: `otpauth://totp/${label}?secret=${encoded}&issuer=one-fetch&algorithm=SHA1&digits=6&period=30`,
        schemaVersion: 1,
        secret: encoded,
      };
    });
  }

  async enable(
    administratorId: string,
    code: string,
  ): Promise<TotpEnableResponseV1 | undefined> {
    return this.#exclusive(async () => {
      const administrator = await this.#administrator(administratorId);
      if (!administrator?.pending_totp_ciphertext) return undefined;
      let secret: Uint8Array;
      try {
        secret = await openSecret(
          administrator.pending_totp_ciphertext,
          this.pepper,
          this.#context(administratorId),
        );
      } catch {
        return undefined;
      }
      if (!(await verifyTotpCode(secret, code, { window: 1 })))
        return undefined;

      const enabledAt = new Date().toISOString();
      const recoveryCodes = createRecoveryCodes();
      const operations: SqlOperation[] = [
        {
          kind: "run",
          parameters: [enabledAt, administratorId],
          sql: `UPDATE administrators SET
            totp_ciphertext = pending_totp_ciphertext,
            pending_totp_ciphertext = NULL, updated_at = ? WHERE id = ?`,
        },
        {
          kind: "run",
          parameters: [administratorId],
          sql: "DELETE FROM recovery_codes WHERE administrator_id = ?",
        },
        ...recoveryCodes.map(
          (recoveryCode): SqlOperation => ({
            kind: "run",
            parameters: [
              randomId("recovery"),
              administratorId,
              this.#recoveryDigest(recoveryCode),
              enabledAt,
            ],
            sql: `INSERT INTO recovery_codes(
              id, administrator_id, digest, created_at
            ) VALUES (?, ?, ?, ?)`,
          }),
        ),
        this.audit.prepare({
          action: "auth.totp.enable",
          actor: { actorId: administratorId, type: "admin" },
          category: "security",
          correlation: {},
          outcome: "success",
          severity: "warning",
        }).operation,
      ];
      await this.database.transaction(operations);
      return { enabledAt, recoveryCodes, schemaVersion: 1 };
    });
  }

  async #administrator(
    administratorId: string,
  ): Promise<AdministratorFactorRow | undefined> {
    return this.database.get<AdministratorFactorRow>(
      `SELECT id, username, totp_ciphertext, pending_totp_ciphertext
       FROM administrators WHERE id = ?`,
      [administratorId],
    );
  }

  #context(administratorId: string): string {
    return `totp:${administratorId}`;
  }

  #recoveryDigest(value: string): string {
    return hmacSha256Hex(
      this.pepper,
      `one-fetch:recovery:${normalizeRecoveryCode(value)}`,
    );
  }

  async #exclusive<Value>(work: () => Promise<Value>): Promise<Value> {
    const previous = this.#tail;
    let release = (): void => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
