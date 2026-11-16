# Production release: external due-diligence access (PR #21)

Read-only access for **Pioneer Bank — Buyer** (role `buyer`) and the **Independent Due Diligence Company —
Reviewer** (role `diligence`). Built on production `main`; independent of PR #20.

## What changes in production

| Area | Change | Existing data |
|---|---|---|
| Cloud Functions | 4 new: `getReviewerData`, `getReviewerExport`, `inviteExternalUser`, `revokeExternalUser`. Existing functions unchanged. | Untouched |
| Firestore rules | One added rule: the owner may read `externalAccess` (the access records). Every other rule unchanged; external roles get no direct access. | Untouched |
| Storage rules, indexes | Unchanged | — |
| Web app | Owner: **External Reviewer Access** page (grant, end date, revoke, last access) and **Preview what reviewers see**. External users: the read-only reviewer portal only. | n/a |
| Data migrations | **None.** Nothing is created until the owner grants access. | — |

## Release steps

1. **Preflight, backup, restore test** (Cloud Shell signed in to production; read-only for the live database):
   ```bash
   cd ~ && rm -rf pioneer-release && git clone -q https://github.com/njdeso/2001-Pioneer.git pioneer-release && cd pioneer-release && bash scripts/prod-preflight.sh before && bash scripts/prod-backup.sh && bash scripts/prod-backup-restore-test.sh
   ```
   Continue only if it ends with **`BACKUP: VERIFIED BY RESTORE`** and every function is in us-central1. Don't use the app until step 3 passes.
2. **Merge PR #21** (merge commit). CI must pass on `main`.
3. **Deploy and after-snapshot** (same Cloud Shell folder):
   ```bash
   git checkout main && git pull --ff-only && npm install && cp -n functions/.env.pioneer-285cf.example functions/.env.pioneer-285cf && CONFIRM_PRODUCTION_DEPLOY=pioneer-285cf npm run deploy:prod && sleep 180 && bash scripts/prod-preflight.sh after
   ```
   - `functions/.env.pioneer-285cf` must hold the production owner email(s) (`OWNER_EMAILS`).
   - Answer **No** to any prompt to delete functions or indexes.
   - The after-snapshot must print **`RESULT: OK`** (no record changed), and each function, the 4 new ones included, must show **204**.
   - If a new function shows **403**, it needs public invocation:
     `gcloud run services add-iam-policy-binding <name-lowercase> --project pioneer-285cf --region us-central1 --member=allUsers --role=roles/run.invoker`.
4. **Publish the web app:** Netlify → Deploys → the `main` deploy for the merge commit → **Publish deploy**.
5. **Verify (about 5 minutes):**
   1. Administration → **External Reviewer Access** → **Preview what reviewers see**. Check the commission summary, statements, clients & policies, carriers and transactions.
   2. Grant access to a test email you control as Pioneer Bank, ending tomorrow. Open the setup link in a private window, set a password and sign in: only the read-only portal appears.
   3. Download one CSV.
   4. **Revoke** the test account; refreshing the portal must be refused.
   5. Then grant access to the real Pioneer and due-diligence contacts, with the end date of the engagement.

**Rollback:** redeploy functions from the previous `main` (`git checkout 6127d2a && npm install && CONFIRM_PRODUCTION_DEPLOY=pioneer-285cf npm run deploy:prod`; answer **Yes** only to deleting the 4 new functions) and re-publish the previous Netlify deploy. Access records and audit entries stay (harmless; they grant nothing without the functions).

## Security model

- **Identity:** Firebase Authentication, email + password. The owner grants access (role, end date ≤ 1 year). The setup link is shown to the owner once.
- **Default deny:** an account without a role (including self sign-up) gets nothing.
- **Owner-only provisioning:** the role claim is set only by `inviteExternalUser` (Admin SDK). It refuses owner emails, internal (admin/staff) accounts, and one account in two organizations.
- **Authorization on every request:** the claim AND the owner record `externalAccess/{uid}` (same role, status active, end date not passed). A forged claim without a record, or the other organization's claim, is refused.
- **Revocation:** takes effect at the next request, even with an unexpired token. The claim is removed, the account disabled and its refresh tokens revoked.
- **No direct database or file access:** external users can't read or write any Firestore document or Storage object (rules deny every role but owner/staff; tested for both roles, every collection).
- **Allowlisted data only:** reviewer functions read only allowlisted fields (Firestore field selection: broker IDs, shares and amounts, notes, contacts, audit fields and file names are never loaded) and build each response field by field.
  - **Never shared:** broker records, advances, buyout data, statement lines and matches, original statement files, the audit log.
  - **Response guard:** every response passes a fail-closed check that blocks any broker-related field or broker ID.
- **Posted vs not posted:** commission totals are the posted ledger only. Approved-not-posted, reconciled-not-posted, disputed and unread statements are listed separately with carrier-printed and extracted amounts, never added.
- **Audit:**
  - every grant, revocation and reviewer view or download is in the audit log, which external users can't read;
  - application logs carry IDs only.
- **Concurrency:** reviewer reads are plain reads; they never lock or write business data, so the owner's work is unaffected (tested with simultaneous edits and reads).

## Residual risks and choices

- **Original statement PDFs and statement lines are not shared** (they can contain sub-producer details). Send specific statements separately if Pioneer asks.
- **Customer information:** insured names, policy numbers and premiums are customer data. Share under the confidentiality agreement. Downloaded files remain with the reviewer after revocation.
- **"Active book" = policies with status `active`.** Commission on since-cancelled policies stays in the posted totals and transactions.
- **Optional hardening:** in the Firebase console, turn off email/password **sign-up** (accounts are created only by the owner's invite). Self-created accounts already get no access.
