export type ControlApiV1Path = `/api/v1/${string}`;

export const CONTROL_API_V1_BASE_PATH = "/api/v1" as const;

function resourcePath(base: ControlApiV1Path, id: string): ControlApiV1Path {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(id)) {
    throw new TypeError("Invalid Control API resource identifier");
  }
  return `${base}/${encodeURIComponent(id)}` as ControlApiV1Path;
}

export const CONTROL_ROUTES_V1 = Object.freeze({
  health: "/api/v1/health",
  capabilities: "/api/v1/capabilities",
  bootstrap: "/api/v1/bootstrap",
  login: "/api/v1/auth/login",
  refresh: "/api/v1/auth/refresh",
  logout: "/api/v1/auth/logout",
  sessions: "/api/v1/auth/sessions",
  totpPrepare: "/api/v1/auth/totp/prepare",
  totpEnable: "/api/v1/auth/totp/enable",
  password: "/api/v1/auth/password",
  configuration: "/api/v1/config",
  policy: "/api/v1/config/policy",
  gatewayPaused: "/api/v1/config/gateway-paused",
  executionTokens: "/api/v1/tokens/execution",
  auditEvents: "/api/v1/audit",
  auditExport: "/api/v1/audit/export",
  features: "/api/v1/features",
  alerts: "/api/v1/alerts",
  backups: "/api/v1/backups",
  executionToken: (id: string) => resourcePath("/api/v1/tokens/execution", id),
  session: (id: string) => resourcePath("/api/v1/auth/sessions", id),
  executionReport: (id: string) => resourcePath("/api/v1/reports", id),
  feature: (id: string) => resourcePath("/api/v1/features", id),
  backup: (id: string) => resourcePath("/api/v1/backups", id),
} satisfies Record<
  string,
  ControlApiV1Path | ((id: string) => ControlApiV1Path)
>);
