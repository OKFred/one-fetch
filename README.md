# one-fetch

one-fetch is a transparent, self-hosted request relay designed for xPanel. It keeps the target method, path, query, body, repeated headers, and response status distinguishable from relay and vendor failures.

The repository is under active `0.1 Preview` development. It targets Cloudflare Workers, Supabase Edge Functions, and Node.js 24+ with one shared protocol and policy core.

## Safety defaults

- The initial system policy is an empty allowlist: no target is reachable until an administrator opts in.
- Request and account operations use an application audit ledger. Bodies, credentials, cookies, tokens, certificates, and private keys are never written to audit storage.
- The gateway owns no business path. Control APIs run on a separate origin.
- There is no OKFred-operated relay or telemetry backend.

## Status

Implementation is in progress. No cloud deployment or stable release is implied by the presence of source code.

## License

MIT

