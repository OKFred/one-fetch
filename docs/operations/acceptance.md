# Cross-adapter acceptance

The conformance package contains one Web-standard synthetic target and one
Gateway fixture set shared by Node, Cloudflare, and Supabase. It never sends a
request to an operator-selected production target.

Build the client and conformance packages, then start the local target when the
Gateway can reach the same machine:

```sh
pnpm --filter @one-fetch/client build
pnpm --filter @one-fetch/conformance build
node tools/acceptance/target-server.mjs --host 127.0.0.1 --port 0
```

For hosted adapter acceptance, deploy the same `handleConformanceTarget`
function as a randomly named temporary HTTPS fixture. Record its exact resource
identifier and remove it after the report is complete.

Put the short-lived execution token in a private file. The runner accepts the
file path, never a plaintext token argument:

```sh
pnpm acceptance:gateway -- \
  --control-url https://control.example \
  --gateway-url https://gateway.example \
  --target-url https://target.example \
  --token-file .tools/execution-token \
  --output artifacts/acceptance/node.json
```

The default smoke suite covers transparent path/query forwarding, static JSON,
URL-encoded, multipart and binary bodies, target error classification,
redirects, repeated `Set-Cookie`, target `Server-Timing`, and streaming. Add
`--full` for 20 MiB boundaries, timeout, cancellation, and truncation checks.

The output is strict `AcceptanceReportV1`. It contains adapter/build/config
identity, a capabilities digest, bounded case observations, and cleanup state.
It contains no request or response body, Header value, credential, or token.
The runner fails if the execution token appears anywhere in the serialized
report and refuses to overwrite an existing report.

Only mark cleanup `verified` after a separate provider inventory confirms every
recorded temporary resource is absent. A passing suite with `cleanup=pending`
is not final release evidence.

After that independent inventory, finalize into a new file. Every `--absent`
value must exactly match a resource recorded in the pending report; the tool
refuses missing, extra, duplicate, or changed identifiers and never overwrites
the original evidence:

```sh
pnpm acceptance:finalize -- \
  --input artifacts/acceptance/cloudflare-pending.json \
  --output artifacts/acceptance/cloudflare.json \
  --absent worker:one-fetch-preview-fixture-a1 \
  --absent d1:one-fetch-preview-a1
```

For a local Node run that records no provider resources, pass
`--not-applicable` instead. This flag is invalid when the report contains any
resource identifiers.
