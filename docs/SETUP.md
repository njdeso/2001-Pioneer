# Setup, deployment, testing and recovery

Everything here is a **new** project. Do not reuse anything from Broker Desk.

## 1. Prerequisites

- Node.js 22+ and npm
- Java 17+ (only for the Firebase emulators / rules tests)
- Firebase CLI: installed by `npm install` (`npx firebase --version`)

## 2. Create the Firebase project

1. <https://console.firebase.google.com> → **Add project** → name it e.g. `agency-sale-manager`.
   Google Analytics: off.
2. **Upgrade to the Blaze (pay-as-you-go) plan** (required for Cloud Functions).
   Then in Google Cloud Console → Billing → Budgets, add a budget alert (e.g. $25/month).
3. **Authentication** → Get started → enable **Email/Password**.
   Users tab → **Add user** with your email and a strong password (this is the owner account).
   Optional: Authentication → Settings → enable multi-factor (TOTP).
4. **Firestore Database** → Create database → production mode → location `nam5` or `us-east4`.
5. **Storage** → Get started → production mode, same region.
6. Project settings → General → **Add app → Web**. Copy the config values for step 4.

## 3. Link the repo to the project

```bash
npm install
npx firebase login
npx firebase use --add          # pick the new project, alias "default"
```

Create `functions/.env` (git-ignored) with the owner email(s):

```
OWNER_EMAILS=you@example.com
```

## 4. Configure the web app

```bash
cp .env.example apps/admin/.env.local
```

Fill in the `VITE_FIREBASE_*` values from step 2.6.

## 5. Deploy the backend

```bash
npx firebase deploy --project prod --only firestore,storage,functions   # production: only after explicit approval
```

The first deploy may ask to enable APIs (Cloud Functions, Cloud Build, Artifact Registry,
Eventarc) — answer yes.

## 6. Deploy the web app to Netlify

1. Netlify → **Add new site → Import an existing project** → GitHub → `2001-Pioneer`.
2. Build settings come from `netlify.toml` (no changes needed).
3. Site configuration → **Environment variables**: add every `VITE_*` variable from
   `.env.example` with your values (`VITE_USE_EMULATORS=false`).
4. Deploy. In Firebase → Authentication → Settings → **Authorized domains**, add your
   Netlify domain (e.g. `your-site.netlify.app`).

## 7. First sign-in

Open the site, sign in with the owner account, and click **Activate owner access**. This runs
`claimOwner`, which (only for emails in `OWNER_EMAILS`) grants the admin role and creates the
default settings and the *Unassigned* broker. Then go to **Administration & Settings** and set
the first month of the 12-month window to match the statements you will load.

## Local development

```bash
# Option A — against your real project: set VITE_USE_EMULATORS=false and run
npm run dev

# Option B — fully local with emulators (no real data):
#   apps/admin/.env.local → VITE_USE_EMULATORS=true, VITE_FIREBASE_PROJECT_ID=demo-asm
npm --workspace @asm/functions run build
npx firebase emulators:start --only auth,firestore,functions --project demo-asm
npm run dev
# Create a user in the emulator UI (http://127.0.0.1:4000 → Authentication),
# put that email in functions/.env OWNER_EMAILS, then sign in and activate owner access.
```

## Development environment

Phase 3 onward is developed and tested in `pioneer-2001-dev`. See [DEV-ENVIRONMENT.md](DEV-ENVIRONMENT.md).

## Testing

| Command | What it checks |
|---|---|
| `npm test` | Shared financial core: money parsing/rounding, negative commissions, policy-number normalization, same number at two carriers, similar client names, snapshot window math, T12/monthly totals, statement-period vs paid-month, carrier-level bonuses kept separate, broker 50% split, schemas, CSV parsing, column detection, import planning (duplicates, conflicts, similar names, updates), undo planning, end-to-end synthetic import |
| `npm run test:rules` | Firestore + Storage security rules in the emulator: role-based reads, no browser writes, audit log admin-only, keys server-only, import batches read-only |
| `npm run typecheck` | TypeScript across shared, functions and the app |
| `npm run build` | Production build of the app and functions bundle |

All test data is synthetic and labelled `SYN-…`.

## Backup and recovery

**Backups**

1. Create a backup bucket: `gsutil mb -l us-east4 gs://<project-id>-backups`
2. Schedule daily Firestore exports (Cloud Console → Firestore → **Disaster recovery** →
   create a daily backup schedule with 14-day retention), or run on demand:
   `gcloud firestore export gs://<project-id>-backups/$(date +%F)`
3. Turn on object versioning for statement files:
   `gsutil versioning set on gs://<project-id>.firebasestorage.app`
4. Keep the GitHub repo as the source of truth for code, rules and indexes.

**Restore**

- Firestore: `gcloud firestore import gs://<project-id>-backups/<date>` (into the same or a new
  project). Restore into a new project first if you only need to inspect old data.
- Storage: restore a prior object version from the bucket's versions list.
- Code/config: redeploy from GitHub (`npx firebase deploy --project prod --only firestore,storage,functions` after approval, Netlify redeploy).
- After any restore, open the dashboard and confirm the T12 total matches the last exported
  due-diligence package.

## Security notes

- The Anthropic API key (Phase 3) lives only in Secret Manager:
  `npx firebase functions:secrets:set ANTHROPIC_API_KEY`. Never in `.env.local` or Netlify.
- Do not commit statements, client lists or exports. `data/` and `exports/` are git-ignored.
- To remove someone's access: Firebase → Authentication → disable the user. Their next request
  is rejected.
