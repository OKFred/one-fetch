# Supabase original-path binding (Protocol V1 extension)

This change is implemented on the development branch, not in the published
`v0.1.0` artifacts. The
[2026-09-13 hosted revalidation](operations/supabase-revalidation-2026-09-13.md)
passed the original double-slash case, but an additional `%20` query-space
probe received signed `invalid_metadata`. A subsequent
[authenticated ingress diagnostic](operations/supabase-ingress-diagnostic-2026-09-13.md)
recorded the hosted Function's raw URL and reproduced the missing normalization
cases locally. The validator now restores their original spelling, including
`%20`, rather than forwarding the observed `+`. Full hosted Gateway revalidation
of this fix is still pending. The
[2026-09-12 hosted report](operations/supabase-revalidation-2026-09-12.md)
remains a failed full-fidelity acceptance for its earlier commit.

## Why the binding is required

Hosted Supabase ingress was observed collapsing repeated path slashes,
decoding path unreserved characters, and re-encoding query components before
the Function received the request. The slash rewrite changed the synthetic
target's result from 404 to 200. Changing
the fixture expectation or merely accepting vendor mutations would hide the
wrong target path.

The client therefore sends the original **Fetch-serialized** pathname and query
in the existing `fetchOptions.adapter` extension point:

```json
{
  "fetchOptions": {
    "redirect": "manual",
    "timeoutMs": 60000,
    "adapter": {
      "supabaseOriginalPathV1": "//v1/echo?tag=one&tag=two&escaped=%2f"
    }
  }
}
```

This is an excerpt of the request metadata, not a complete Gateway request.
`protocolVersion` remains 1, and no strict top-level schema is widened. The
outer Gateway URL still contains the target path/query after the configured
Function prefix. No `/v1/execute` or other target path is reserved. The binding
counts toward the existing **48 KiB decoded metadata limit** and is neither an
upstream Header nor an option passed to the platform's upstream Fetch call.

## Capability handshake and upgrades

Control advertises exactly one Fetch-option capability named
`adapter.supabaseOriginalPathV1` with `fidelity: "exact"`. The shared client
constructs the binding from its parsed target URL only after that handshake.
It preserves caller options and rejects a caller-supplied conflicting binding.
Node and Cloudflare do not advertise this extension and receive no injected
binding.

- Updated client + updated Supabase: original path binding is mandatory for
  every HTTP execution, including paths that appear unaffected.
- Old client + updated Supabase: an authenticated request without the binding
  receives a signed `relay-error` with `unsupported_option`, before quota or
  upstream work. Mutation confirmation does not bypass this requirement.
- Updated client + old Supabase capabilities: the existing
  `adapter.supabaseAcceptMutations` marker without exact binding support causes
  local rejection before Fetch. Duplicate or downgraded binding declarations
  are also rejected.
- A client that omits capabilities cannot identify an arbitrary old deployment
  from its URL alone. **Always fetch fresh Control capabilities and reconstruct
  the Gateway client after an upgrade.** Do not assume the generic no-handshake
  constructor protects old hosted deployments against normalization.

Upgrade the paired Control/Gateway build and the locked client artifact
together. Existing Release URLs and integrity hashes are immutable; this fix
does not overwrite their contents. The administration site's capability panel
shows the deployment's HTTP detail, including the binding requirement.

## Validation and execution

After authentication and configuration validation, the Function removes its
own prefix and compares the observed path and query separately with the
binding. Only these known spellings are accepted:

- Path: original bytes, uppercase percent escapes, or decoded ASCII unreserved
  characters (`A-Z a-z 0-9 . _ ~ -`) with other escapes uppercased. Each form
  may also collapse repeated path slashes. Path `%20` never becomes `+`.
- Query: original bytes, uppercase percent escapes, or bytewise form-style
  re-encoding of each key/value. Space becomes `+`, an existing literal `+`
  remains `+`, encoded plus remains `%2B`, and only `A-Z a-z 0-9 * . _ -`
  remain unescaped. Percent bytes are decoded once for this comparison only;
  there is no UTF-8 replacement or recursive decoding.
- Literal query separators, repeated-field order, bare flags without `=`,
  and empty segments must remain intact. Reordering, dropping fields, decoding
  an escaped `&` into a new field, or changing an encoded plus to a literal
  plus is rejected. This is not arbitrary decoded-query equivalence.

The comparison does **not** rewrite the outgoing request. Successful validation
returns the exact original binding, even when the observed query uses `+`
where the original used `%20`. Query slashes are not collapsed; their escaped
spelling can change under the verified component re-encoding.

Other rewrites, malformed escapes, URL references, raw spaces/control characters,
backslashes, fragments, and non-Fetch-serialized dot segments are rejected with
a signed `invalid_metadata` error. A failed binding never establishes an
upstream connection or acquires execution quota. Error text omits path values.

Valid binding bytes are concatenated with the independently validated target
origin, never resolved as a URL reference. A leading `//` therefore stays in
the path and cannot replace the target host. System policy, user deny rules,
token scope checks, initial target execution, and request auditing all use the
restored URL. Subsequent redirects use their own URLs and are rechecked as
usual; the initial binding is not reapplied to them.

This restores the URL serialized by Fetch, not an arbitrary pre-parsed input
string. Client URL parsing still applies normal Fetch URL serialization. The
binding is not a promise that Supabase accepts every possible URL: unrecognized
ingress changes fail closed. Upstream vendor behavior remains subject to the
adapter's other capability warnings and hosted tests.

## Privacy and verification boundary

The binding contains the target query and can contain credentials. It stays in
request metadata, which must not be logged or exported as diagnostic evidence.
Application audit uses the existing sensitive-query redaction and never stores
the adapter metadata wholesale. The original path still appears in the outer
URL, so this extension does **not** prevent provider access logs from observing
it.

Local coverage includes 16 recorded hosted ingress pairs, 400 generated
slash-run combinations, unknown rewrites,
capability mismatch, metadata limits, the shared HTTP smoke suite behind
simulated hosted normalization, signed denials, system/user rules, redirects,
and audit/report secret canaries. This simulation uses the real client and
Function handler with a synthetic upstream and database port; it is not a
hosted Gateway or PostgreSQL acceptance result. The separate ingress diagnostic
is real hosted URL-observation evidence, not a complete request relay test.

Before merge/release, rerun the exact future commit on a disposable hosted
project, including the new exact query-space/plus fixture. Retain the original
literal-path 404 expectation and record cleanup separately from test success.
The 20 MiB + 1 client timeout was observed again in the hosted revalidation;
this path fix does not establish prompt stream termination or upstream
cancellation latency.
