# One-time Personal/Commercial correction (Nov 2026)

**Problem.** Many Personal accounts show as Commercial. The import defaulted to Commercial whenever the file
had no Personal/Commercial column, and the client form started at Commercial. A new policy also copied its
client's (possibly wrong) classification.

**Fix, in two parts:**

1. **One-time data correction** (`scripts/prod-line-correction.mts`), using each policy's **line of business**
   (the *Policy type* field) as the source of truth.
2. **Future imports and forms** never default Personal accounts to Commercial (see the end of this page).

Authorized by the owner on Nov 19, 2026. This is separate from PR #27 (the production functions deploy) and from
the Security Mutual statement work. It **supersedes PR #25**. That PR flipped every Commercial client to Personal
without reading the line of business. Do not run `scripts/prod-client-classification-fix.py` from that PR.

## What decides Personal or Commercial

`packages/shared/src/lineOfBusiness.ts` reads the policy type as whole words:

| Policy type examples | Result |
|---|---|
| Homeowners, HO-3, Renters, Condo, Dwelling Fire / DP-3, Personal Auto, PPA, Motorcycle, Boat, RV, Mobile Home, Jewelry, Personal Articles, anything starting "Personal" | **Personal** |
| BOP, Businessowners, Commercial…, CPP, GL / CGL, Workers Comp / WC, NYS DBL, PFL, Business / Commercial Auto, Garage, Builders Risk, E&O, D&O, EPLI, Cyber, Bonds, Condo / Homeowners **Association**, Home-based business, Apartment building | **Commercial** |
| Auto, Umbrella, Excess, Flood, Inland Marine, Property, Liability, Package, Landlord, Life, Fire, blank, unknown, or words of both kinds (e.g. "Home Improvement Contractor") | **Manual review**: never changed |

**Spelling and abbreviations.** These are read before matching, and every correction is listed in the preview:

- **Abbreviations:** Genl/Gen'l/Gen → General, Liab → Liability, Comm/Coml/Cml → Commercial, Pers → Personal,
  H/O → Homeowners, Pvt Pass → Private Passenger, Bus Auto → Business Auto, Wkrs Comp / W/C → Workers Comp,
  Umb → Umbrella, Dwell → Dwelling, Prof → Professional.
- **Typos** such as Homowners → Homeowners. A word is corrected only if it is 6+ letters, starts with the same
  letter, is one letter off (two for long words), and matches exactly one known word. Anything else stays as
  typed (e.g. "Personnel", "Trust", "Contracts").

**Evidence for ambiguous lines of business** (e.g. a bare "Auto"). It is used only for policies whose line of
business doesn't decide, and only when every signal found agrees. Any contradicting signal keeps the policy
unchanged, even a signal of a kind you didn't accept.

| Evidence | Source | Used |
|---|---|---|
| Statement classification | Matched lines on a statement **you** marked Personal Lines / Commercial Lines (duplicate check) | default |
| Statement section | The carrier printed the line under a section such as "PERSONAL AUTO" / "COMMERCIAL AUTO" | default |
| Statement title | The carrier's title says Personal/Commercial (e.g. "Personal Lines Statement") | default |
| Business-entity name | Named insured or client is an LLC, Inc, Corp, Ltd, LLP, PLLC, LP or DBA → Commercial only | opt-in: `--evidence statement,entity_name` |
| Policy-number pattern | At the same carrier, all of ≥10 policies with the same number pattern and a clear line of business are one type | opt-in: `--evidence statement,policy_number_pattern` |
| Client's other policies | Shown for information only | **never** (a business owner can have a personal home and a commercial auto) |

Only confirmed matches count (`matched`, not suggested/ambiguous), and discarded statements are ignored. These are
**never** evidence: the policy's current Personal/Commercial value, the client's classification (both are what's
being corrected), commission rates and premiums. `--evidence none` uses the line of business only. The accepted
kinds are sealed into the plan hash. The preview always reports evidence you didn't accept, and what it would decide.

You can settle any review value after reading the preview, e.g. `{"umbrella": "personal"}`. Run preview again
with `--overrides`. Your decisions are sealed into the plan, and a value you mark `"review"` is never decided by evidence.

**Policies:** every status counts (active, expired, cancelled, pending).

**Clients**, from their corrected policies:

- All Personal → Personal.
- All Commercial → Commercial.
- Both → **current value kept, flagged**. The app has no "Mixed" classification.
- No policies, or any policy needing review → **current value kept, flagged**.

**Never written:** policy numbers, carriers, premiums, commissions, effective and expiration dates, policy
status, names, brokers, the ledger, statements or anything else. The only fields written are `policies.line`,
`clients.classification`, and `updatedAt`/`updatedBy` (`updatedBy` = `maintenance:line-correction-2026-11`).

## Where it runs

Run it in Cloud Shell, or on any computer with **Node 22.18+** and **gcloud** signed in as the owner. On Node 22.6–22.17,
add `--experimental-strip-types` after `node`. No `npm install` is needed. It talks to Firestore's REST API with
your own `gcloud auth print-access-token`. It refuses any project except `pioneer-285cf` (number 933119340508) and
`pioneer-2001-dev` (number 994437988131), both checked with Google.

```bash
cd ~/2001-pioneer && git fetch origin && git checkout fix/line-of-business-classification && git pull
mkdir -p ~/pioneer-release/line-correction-2026-11 && cd ~/pioneer-release/line-correction-2026-11
node --version            # 22.18 or later (else add --experimental-strip-types)
gcloud config set project pioneer-285cf
```

## Step 1: full backup (recommended, before preview)

The script keeps its own backups, but also take the managed database export you already use:

```bash
bash ~/2001-pioneer/scripts/prod-preflight.sh before
bash ~/2001-pioneer/scripts/prod-backup.sh
```

## Step 2: preview (read-only; changes nothing)

```bash
node ~/2001-pioneer/scripts/prod-line-correction.mts preview --project pioneer-285cf
```

This creates `line-correction-preview-<UTC time>/` with:

| File | What it is |
|---|---|
| `preview.md` | Counts of clients and policies to change (→ Personal / → Commercial), by policy status; exceptions by type; every line of business and its decision |
| `preview-policies.csv`, `preview-clients.csv` | Every record: current value, new value, action, reason |
| `exceptions.csv` | Records left for manual review |
| `line-of-business.csv` | Every distinct policy type, how many policies, the decision, spelling corrections, evidence counts |
| `evidence-review.csv` | Every ambiguous policy: carrier, wholesaler, named insured, every evidence signal (accepted or not), the client's other policies, decision |
| `crosscheck-lob-vs-statements.csv` | Policies whose clear line of business is contradicted by statement evidence (the line of business still decides) |
| `lob-overrides.template.json` | The review values, ready for you to settle |
| `backup-clients-policies.json` | **Full backup** of all clients and policies exactly as stored |
| `plan.json` | The sealed plan (SHA-256 hash) that apply will execute |

The preview and report files contain **no broker names, IDs, shares, premiums or commissions**. The backup
files are complete records and include broker fields. Keep them in Cloud Shell. **Never** send them to Pioneer
or the due-diligence reviewers.

Optional: settle review values, then preview again:

```bash
cp line-correction-preview-*/lob-overrides.template.json lob-overrides.json   # edit: "review" → "personal"/"commercial"
node ~/2001-pioneer/scripts/prod-line-correction.mts preview --project pioneer-285cf --overrides lob-overrides.json
```

**Send `preview.md` (and the CSVs if you like) to Claude for review, then approve.** Nothing changes until you do.

## Step 3: apply (only after you approve the preview)

```bash
node ~/2001-pioneer/scripts/prod-line-correction.mts apply line-correction-preview-<UTC time>
```

1. It checks the plan's hash, so a plan edited after the preview is refused.
2. You type the confirmation it shows, `APPLY <number of changes> pioneer-285cf`.
3. It re-reads every affected record and saves it to `apply-backup.json` **before** any write.
4. It creates `maintenance/line-correction-2026-11` with "must not exist", so it can run **only once**.
5. Each change applies only if the record is **unchanged since the preview**. Anything edited in between is
   skipped and reported, never overwritten.
6. **Audit trail:** each change and its audit-log entry commit together (`action: line_correction`, with
   before/after and the reason). The audit log is owner-only (`isAdmin` in the rules).
7. It writes `apply-result.json` / `apply-result.csv` (changed / skipped, per record), then runs **verify**.

## Step 4: verify (read-only)

```bash
node ~/2001-pioneer/scripts/prod-line-correction.mts verify line-correction-preview-<UTC time>
```

Verify checks four things:

- Every applied record holds its new value.
- **Every other field of every changed record is identical to the backup.**
- The client and policy counts are unchanged.
- The marker is present.

The results go to `verify-<time>.md`.

## Rollback

```bash
node ~/2001-pioneer/scripts/prod-line-correction.mts rollback line-correction-preview-<UTC time>
```

- You type `ROLLBACK <n> pioneer-285cf`.
- It restores the previous value **only** on records that still hold the corrected value and have not been
  written since. Anything you edited afterwards is skipped and listed in `rollback-result.csv`.
- Each restore writes an audit entry (`line_correction_rollback`), and the marker records `rolled_back`.
- Last resort: the full export from Step 1 (`prod-backup-restore-test.sh` shows how to restore it into a
  separate database). Each record's previous value is also in `apply-backup.json` and in its audit entry.

## What else changes when the data is corrected

- **Dashboard** Personal/Commercial split and the **reviewer portal**/diligence exports show the corrected
  policy line and client classification. That is the point of the correction. No broker data is involved.
- Commissions, matching, posting, the ledger and broker buyout figures don't use these fields, so they are unaffected.
- An earlier import's **Undo** treats corrected records as "edited after the import" and leaves them alone.
  That is the safe outcome.

## Future imports and forms (part 2 of this change)

- **Import:**
  - The file's Personal/Commercial column still wins, now with a warning when it contradicts the policy type.
  - Without one, the **policy type decides**.
  - When neither says, the default is now **"Don't guess — flag the row"**, so the row isn't imported. You can
    still choose Personal or Commercial as a default, and each row that uses it says so.
  - New clients take their classification from all their policies in the file. Mixed new clients get a warning.
  - A new policy no longer copies its client's classification.
  - Existing policies change line only from an explicit column. Existing clients are never reclassified by an
    import.
- **Client form:** a new client has no preselected classification, so you choose Personal or Commercial.
- **Policy form:** typing a policy type sets the line (Homeowners → Personal) until you choose one yourself. A
  mismatch shows a warning.
- **Release order matters:**
  1. Deploy the import functions `stageImport` and `commitImport` first. This is a separate deploy, not part of
     PR #27, whose workflow is pinned to two other functions.
  2. Then publish the web app on Netlify.

  The new Import page sends "don't guess" as an empty default, which the current server rejects. Publishing
  first would make imports fail with a validation error until the functions are deployed. Nothing would be
  imported wrongly, but it would be confusing.
- **The one-time correction (Steps 1–4) needs no deploy at all.** It can run before, after or without part 2.
