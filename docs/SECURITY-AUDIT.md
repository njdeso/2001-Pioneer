# Dependency security audit — production dependencies

Scope: `npm audit --omit=dev` (Cloud Shell, Phase 2, 15 findings: 5 high, 10 moderate).
npm counts every package on a vulnerable chain, so the 15 findings come from three root advisories.

## Findings and where they matter

| Advisory | Severity | Fixed in | Path(s) | Deployed exposure |
|---|---|---|---|---|
| **zod** GHSA-mrhx-c7xc-m3w5 — memory exhaustion validating oversized constrained collections | High | 4.6.6 (no zod 3 fix) | direct dependency of `@asm/shared`, `@asm/admin` | **Yes, both tiers.** The browser validates forms with it, and **Cloud Functions validate every callable request with it** (server-side DoS risk). Our arrays are already length-capped (e.g. 10,000 import rows), which limited exposure, but the library itself needs the fix. |
| **@grpc/grpc-js** GHSA-5375-pq7m-f5r2 / CVE-2026-48068 — malformed HTTP/2 request crashes a gRPC *server* | High | 1.14.4 (also 1.9.16, 1.10.12, 1.11.4, 1.12.7, 1.13.5) | `firebase-admin` → `@google-cloud/firestore` → `google-gax` → `@grpc/grpc-js`; `firebase` → `@firebase/firestore` (Node build only) | **Not reachable:** the app runs no gRPC server. Patched anyway. |
| **@grpc/grpc-js** GHSA-99f4-grh7-6pcq / CVE-2026-48069 — invalid compressed message crashes client or server | High | same as above | same as above | **Functions runtime (low practical risk):** Functions use grpc-js as a *client* to Firestore, so only Google's Firestore backend could send such a message. The browser app does not use grpc (Firestore web uses WebChannel); the Node path is used only by dev-time rules tests. |
| **uuid** GHSA-w5hq-g745-h8pq / CVE-2026-41907 — missing bounds check in `v3()/v5()/v6()` when a buffer is passed | Moderate | 11.1.1 (12.0.1, 13.0.1, 14.x are ESM-only) | `exceljs` (uuid ^8); Google Cloud client libraries used by `firebase-admin` (uuid 9–10) | **Not reachable:** these libraries call `v4()` only, never v3/v5/v6 with a caller buffer. Patched anyway. |

## Remediation (this commit)

- **zod → `^4.6.6`** in `@asm/shared`, `@asm/admin` and the root. Code migrated to zod 4:
  - `contactSchema` uses `.prefault({})`. In zod 4, `.default({})` returns `{}` without applying inner defaults, so `.prefault` keeps the old behavior where every contact field defaults to `''`.
  - `ZodTypeAny` / `schema['_output']` replaced by `ZodType` / `z.output<>` in Functions and forms.
  - Issue paths stringified explicitly (zod 4 paths may contain symbols).
- **Root `overrides`** (targeted; no `npm audit fix --force`, no Firebase or exceljs downgrade):
  - `"@grpc/grpc-js": "^1.14.5"`: patched for both high advisories and the later 1.14.5 error-message fix. All consumers depend on grpc-js 1.x.
  - `"uuid": "^11.1.1"`: the patched line that still ships CommonJS, so `require('uuid')` in exceljs and the Google libraries keeps working on Node 22. uuid 12+ is ESM-only and was deliberately avoided.
- Added `npm run audit:prod`.

## Verification

Run here (this environment cannot reach the npm registry, so zod 4 was exercised through the zod 4 API that zod 3.25 bundles):

- 51 shared tests pass under zod 4 semantics. The 2 exceljs round-trip tests run only after `npm install`.
- The shared package type-checks against zod 4 types.
- Functions bundle builds (zod 4 bundled, exceljs absent) and the app compiles.
- Server-side validation checked under zod 4: errors are still `ZodError`, field errors map correctly (including the cross-field date rule), and import option/record defaults are unchanged.

To confirm in Cloud Shell:

```bash
rm -rf node_modules package-lock.json
npm install
npm ls zod @grpc/grpc-js uuid        # expect zod 4.6.x, grpc-js 1.14.5+, uuid 11.1.x everywhere
npm run audit:prod                    # expect 0 vulnerabilities
npm test && npm run test:rules && npm run typecheck && npm run build
git add package-lock.json && git commit -m "Add lockfile" && git push   # recommended
```

## Residual risks

1. **Overrides cross upstream ranges.** `@firebase/firestore` pins grpc-js `~1.9.x`, and the override moves it to 1.14.x. That code path runs only in Node (the rules tests), never in the browser bundle, and grpc-js keeps API compatibility across 1.x. `npm run test:rules` exercises this path.
2. **exceljs browser bundle.** exceljs ships a prebuilt browser file with its own copy of uuid inlined. Overrides cannot change that copy, and npm audit does not see it. Only `v4()` is called, so the advisory is not reachable.
3. **No lockfile in the repo yet.** Until `package-lock.json` is committed, each install resolves the newest allowed versions. Commit the lockfile after a clean audit.
4. **zod 4 default messages** differ from zod 3 for rules where we did not set our own message. All user-facing form rules here use custom messages.
