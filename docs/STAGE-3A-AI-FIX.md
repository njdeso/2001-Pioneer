# Stage 3A fix — AI statement reader (Claude) diagnosis and repair

Status: code fixed and tested locally. **Not deployed.** Production (`pioneer-285cf`) data and
settings were not touched.

## What was actually wrong

| Symptom | Real cause | Evidence |
|---|---|---|
| Every failure showed only "HTTP 401 / 400 / 404" | `extractWithClaude` discarded Anthropic's error body (`error.type`, `error.message`, `request_id`), so the reason was never recorded or shown. | Source: the `!res.ok` branch built the message from `res.status` only. |
| HTTP 401 | Anthropic rejected the key. Endpoint, `x-api-key` header and `anthropic-version: 2023-06-01` were correct. The key was sent untrimmed, so a secret stored with a trailing newline/space (common when pasted into `firebase functions:secrets:set`) is rejected with 401. | After the key was replaced the error changed to 400; Anthropic authenticates before validating the request, so the new key is being accepted. |
| HTTP 404 with `claude-sonnet-4-5-20250929` | Valid ID, but **not available to this account**. Anthropic deprecated it on 2026‑09‑30 (retires 2026‑11‑30) and recommends `claude-sonnet-5-5`. A deprecated model can be unavailable to accounts that were not already using it. | Anthropic model-deprecations page. 404 `not_found_error` is the API's answer for a model the key cannot use. |
| HTTP 400 with `claude-sonnet-5-5` | `claude-sonnet-5-5` **is a valid, current ID** (it is Anthropic's named replacement), and an unknown model returns 404, not 400. So the 400 is a request- or account-level rejection. The most common 400 on a newly created key is "Your credit balance is too low…" (billing). Other possibilities: a request limit such as `max_tokens` or PDF page count. The exact reason was thrown away by the old code — the new **Test AI connection** check reports it. | Same as above. |
| Possible stuck "Processing…" | Retries could run 3 × 240 s + waits ≈ 12 min, longer than the 540 s function limit. The function would be killed with the statement left in `processing`, and every retry refused with "This statement is processing." | `timeoutMs 240000`, `maxRetries 2`, `timeoutSeconds 540`. |
| April 2026: "duplicate" on re-upload | `registerStatementUpload` reserves the file fingerprint before the browser uploads. When the upload failed (Storage permissions), the fingerprint stayed reserved to a record that has no file, so the same file was always reported as a duplicate. | `statementKeys/{sha256}` → statement with `originalPath: null`. |

## What changed

**`packages/shared/src/statements/anthropic.ts` (new)** — reads Anthropic's error body and `request-id`, classifies it
(auth, permission, billing, model_not_found, invalid_request, too_large, rate_limited, overloaded, server), and
writes a plain-English explanation. Trims the key; flags quotes, inner spaces, or a non-`sk-ant-` key. Scrubs anything key-like from stored messages.

**`ai.ts` → `extractWithClaude`**
- Error messages now include Anthropic's reason and request ID.
- Model ID format is checked before any request (`bad_model`).
- Overall time budget (450 s) so the function always finishes and records the failure.
- Honors `retry-after` on 429.
- **Request format:**
  - Native structured output (`output_config.format`, JSON Schema) is the default. Claude Sonnet 5.5 rejects any forced tool choice with HTTP 400 *"tool_choice: type 'tool' and 'any' are not supported for this model"*.
  - If a model or endpoint rejects structured output, the same schema is sent as a `record_statement` tool with `tool_choice: auto`.
  - Every answer is validated with zod and reconciled to the cent.
  - If Anthropic reports a lower `max_tokens` limit, the request is retried with that limit.

**`diagnose.ts` (new) + `checkAiConnection` function (new)** — Settings → **Test AI connection**:
1. key present and well-formed (shows length and last 4 characters so you can confirm Secret Version 3 is live);
2. `GET /v1/models` — does Anthropic accept the key (free);
3. `GET /v1/models/{model}` — can **this key** use the configured model; lists the models it can use;
4. a real extraction through `extractWithClaude`, the same code statement processing uses, on a 2-row synthetic statement, which must reconcile to the cent. It catches billing, permission and request-format 400s, and answers that don't validate.

**`processStatement`**
- Stores `httpStatus`, `errorType`, `apiMessage`, `requestId` on the statement and the extraction run.
- Logs them to Cloud Logging (never the key or the document).
- A statement stuck in `processing` for over 12 minutes can be retried.
- Unexpected errors are logged instead of swallowed.

**`registerStatementUpload`** — if the fingerprint belongs to a record whose file never reached Storage
(`awaiting_upload`, or failed with `not_uploaded` / `file_mismatch` / `wrong_type`, and no `originalPath`), the same file
is uploaded into **that same record** instead of being called a duplicate. Nothing else in the record changes; an audit entry
`resume_upload` is written. Real duplicates (file stored) are still blocked.

**App** — Settings has the Test AI connection panel and a model picker filled from the key's model list. A failed statement
shows the error code, HTTP status, Anthropic error type and request ID, and links to the test.

No data migration or schema changes. The only rules change, refusing an upload to an occupied path, is in PR #1.

## Tests

`npm test` (shared): **91 passed, 1 skipped** in CI (the skipped test needs the real Travelers PDF, which is not in the repo).
New file `test/statements-anthropic.test.ts` covers 401/400‑billing/400‑other/404 classification, key trimming, invalid model,
`max_tokens` and tool-choice fallbacks, the time budget, `retry-after`, and every diagnosis outcome — all with mocked network.
CI (`.github/workflows/ci.yml`) runs `npm install`, `typecheck`, `test`, `build` and `test:rules` (Firebase emulator) on every pull request.

## Deploy and verify

See [PRODUCTION-RELEASE.md](PRODUCTION-RELEASE.md): automated dev deploy and live smoke test, then the production steps and rollback.
