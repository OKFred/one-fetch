# Technology baseline

The `1.0` baseline intentionally uses one shared TypeScript core and thin runtime
adapters. Versions are exact in package manifests and the committed pnpm/Deno
locks; this page describes the boundary rather than replacing those locks.

## Shared workspace

- Node.js `>=24.20.0 <27`, production default Node 24 LTS; Node 26 is a CI lane.
- pnpm 11.25.0, ESM-only TypeScript 5.9.2 project references.
- Zod 4.5.4 for strict runtime protocol validation and JSON Schema generation.
- Vitest 4.1.11 and fast-check 4.9.0 for examples and property tests.
- ESLint 9.35.0 with type-aware TypeScript rules; Prettier 3.6.2.

`packages/core` uses Web Crypto, Fetch-compatible types, streams, and other Web
standards. It cannot import runtime packages. `packages/client` uses native
Fetch/WebSocket. No shared package is published to npm.

## Control and Gateway

Control uses Hono 4.13.5 and `@hono/zod-openapi` 1.6.2. Gateway entry points do
not use Hono, Express, Fastify, Oak, Axios, Got, or node-fetch; they adapt the
runtime's native request, stream, socket, DNS, and TLS primitives.

- Cloudflare pins Wrangler 4.128.0 and Workers Vitest Pool 0.22.0. Control uses
  D1 plus per-purpose Auth/Quota Durable Objects and Service Bindings.
- Supabase pins CLI 2.116.0 and per-function Deno 2.9.6 locks. PostgreSQL writes
  go through restricted transactional RPCs.
- Node uses two listeners, `node:http`/`node:https`, `dns/promises`, `net`, `tls`,
  ws 8.21.3, and built-in `node:sqlite` in a Worker Thread. There is no ORM or
  fallback database driver.

SQLite/D1 and PostgreSQL have explicit forward-only migration sets. There is no
cross-database ORM. Unknown newer schema versions refuse startup.

## Administration UI

Admin is a static Vue 3.5.42 + Vite 7.3.6 application with Vue Router 4.6.4,
Pinia 3.0.4, Tailwind CSS 4.3.3, Reka UI 2.10.4, Lucide, and vue-i18n 11.4.10.
It uses the shared client and native Fetch. It has no SSR, Nuxt, BFF, Axios,
TanStack Query, third-party scripts, analytics, fonts, or CDN runtime assets.

## Deliberate exclusions

The initial release does not use JWT/Supabase Auth as one-fetch identity, KV for
strong state, Prisma/Drizzle, floating Deno imports, remote code, Sentry, public
proxy infrastructure, or Node SEA. TypeScript 7, Vite 8, Vitest 5, Vue Router 5,
and Pinia 4 wait until the protocol/adapters are stable.
