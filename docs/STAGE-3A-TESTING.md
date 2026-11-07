# Stage 3A — how to test

Stage 3A uploads, fingerprints, reads, validates and reconciles commission statements.
**It does not match, approve or post anything.** No ledger entries, clients, policies or
broker figures are created or changed.

## 1. Automated checks (Cloud Shell, on the feature branch)

```bash
git fetch origin && git checkout feature/phase-3a-statement-extraction
rm -rf node_modules package-lock.json && npm install
npm test                    # shared suite: money, imports, Excel, Travelers parser, reconciliation, AI fallback (mocked)
npm run test:rules          # Firestore + Storage rules incl. statement uploads (needs Java)
npm run typecheck
npm run build
```

**Optional:** run the parser against the real December 2025 Travelers statement. Keep the file outside the repo, or in the git-ignored `data/` folder; never commit it.

```bash
TRAVELERS_REAL_PDF=/path/to/2001_Central_Dec_25.pdf npm test
```

The real-file test asserts that the statement reconciles exactly:

| Check | Expected |
|---|---|
| Paid commission (monthly commission payable) | **$3,631.14** |
| Payment received (not revenue) | $27,573.43 |
| Premium for commission | $24,338.00 |
| Transaction premium | $24,592.00 |
| Lines | 102 |

## 2. In `pioneer-dev` (after docs/DEV-ENVIRONMENT.md)

1. **Settings:** leave the AI reader **off**.
2. **Carriers:** confirm *Travelers* exists (seeded), and add your Travelers agency code under *Your agency codes on its statements*. Statements are also recognized by carrier name.
3. **Upload Commission Statements:** drop the Travelers PDF. Expect **"Reconciled exactly — 102 lines ready for review."**
4. **Open the statement.**
   - **Status and method:** Reconciled — review, Parsed (Travelers).
   - **Reconciliation:** every check ✓, difference $0.00. The carrier statement total is $3,631.14; posted is $0.00 and pending is $3,631.14.
   - **Tabs:** Commission (28), Payment-only (74), Negative (6), With checks (0).
   - **Policy numbers** appear exactly as printed (with their spaces, e.g. `123456789 203 1`).
   - **View original** opens the preserved PDF through a 5-minute link.
5. **Duplicate file:** upload the same PDF again. Expect *"This exact file was already uploaded"*, with a link to the first one.
6. **Discard:** discard the statement with a reason. The statement and its lines remain, marked Discarded. Uploading the file again now works.
7. **Unfamiliar layout with AI off:** upload any other carrier's PDF, CSV or XLSX statement. Expect **Processing failed: "…the AI reader is turned off in Settings."**
8. **AI reader:** turn it on with a monthly limit of 5. On the failed statement, click **Retry with AI**.
   - Expect *Reconciled* or *Discrepancy* with the reasons listed. The statement shows a "Read by AI: check the lines…" notice.
   - Settings shows the month's AI usage.
   - Lowering the limit to the number already used makes the next AI read fail with a clear limit message.
9. **Audit log** (Settings): entries for registration, extraction, duplicate checks, discard, payer changes and original-file views.
10. **Nothing posted:** the Dashboard, carrier, broker and client pages still show $0.00 posted commission, and no clients or policies were added.

## 3. What to look for / report back

- Any line whose values differ from the PDF.
- Any statement that should reconcile but shows a discrepancy, or the reverse.
- Anything confusing in the review screen. Stage 3B adds matching to your policies on this same screen.
