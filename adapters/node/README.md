# one-fetch Node adapter

The Node adapter runs two independent listeners: the Hono Control API and the transparent native HTTP Gateway. It requires Node `>=24.20.0 <27` and refuses to start if the built-in `node:sqlite` probe or database integrity check fails.

Copy `.env.example` into your secret manager or service configuration. Do not commit a populated `.env`. Generate an Ed25519 PKCS#8 key and independent random instance/protocol secrets before first start.

```bash
pnpm --filter @one-fetch/adapter-node build
node adapters/node/dist/cli.js
```

The initial process prints a one-time bootstrap token. The token is stored only as a digest and cannot be recovered later. The default system policy is an empty allowlist, so execution tokens cannot reach any target until an administrator adds explicit allow rules.

Target response headers, including repeated `Set-Cookie`, are transported inside signed one-fetch response metadata. They are never applied to the Gateway origin. DNS, TCP, TLS, TTFB and target-provided `Server-Timing` are reported when measurable; connection reuse or proxying can make individual phases unavailable.
