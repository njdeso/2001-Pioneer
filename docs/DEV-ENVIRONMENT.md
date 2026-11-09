# `pioneer-2001-dev` development environment

Phase 3 is built and tested in a separate Firebase project, **`pioneer-2001-dev`**. Production
(**`pioneer-285cf`**) is never touched during development.

> **Nothing here has been created yet.** These are the steps for you to run when you are ready
> to test Stage 3A. Every command names its target project explicitly.

## Safety rails in the repo

- **Explicit aliases only.** The committed `.firebaserc` defines `dev` → `pioneer-2001-dev` and `prod` → `pioneer-285cf`, with **no default**, so every Firebase command must say where it goes.
- **Guarded dev scripts.** `npm run deploy:dev` and `npm run seed:dev` first run `scripts/assert-dev-target.mjs`, which refuses any project that isn't `*-dev` or `demo-*`. It refuses `pioneer-285cf` by name.
- **No production deploy script.** `npm run deploy:prod` only prints a reminder and exits. Production deploys are typed by hand, after your approval.
- **DEV banner.** The app shows a yellow banner whenever it is connected to anything other than `pioneer-285cf`.
- **Separate configs.** The dev web config lives in `apps/admin/.env.dev.local` and is used only by `npm run dev:pioneer-2001-dev`. The production build uses the Netlify environment variables, as before.

## One-time setup

1. **Create the project.** At <https://console.firebase.google.com>, choose **Add project**, name it `pioneer-2001-dev`, and turn Analytics off. Upgrade it to **Blaze** (pay-as-you-go), then add a small budget alert (e.g. $10/month) in Google Cloud Billing.
2. **Authentication.** Get started, enable Email/Password, then **Add user** with your email. You can reuse your normal email; this is a different project with a separate password.
3. **Firestore.** Create the database in production mode, in the same location as `pioneer-285cf`.
4. **Storage.** Get started in production mode, in the same location.
5. **Web app.** In Project settings, add a Web app and copy its config:
   ```bash
   cp apps/admin/.env.dev.example apps/admin/.env.dev.local   # then fill in the values
   ```
6. **Project aliases.** Nothing to do: `.firebaserc` is committed with `dev` → `pioneer-2001-dev` and `prod` → `pioneer-285cf` and no default. A fresh clone is ready.
7. **Owner email for dev:**
   ```bash
   cp functions/.env.pioneer-2001-dev.example functions/.env.pioneer-2001-dev   # set OWNER_EMAILS
   ```
8. **Anthropic API key, as a backend secret only.** Use a **separate key** for dev, with a low spending limit set in the Anthropic Console.
   ```bash
   npx firebase functions:secrets:set ANTHROPIC_API_KEY --project dev
   ```
   Paste the key when prompted. It is stored in Google Secret Manager, never in the repo, `.env` files, or the browser.

   **Production note:** before Stage 3A is ever deployed to `pioneer-285cf`, the same secret must also be set there (`--project prod`), or that deploy will fail.
9. **Allow signed links to originals.** The "View original" button needs this one IAM grant:
   ```bash
   PN=$(gcloud projects describe pioneer-2001-dev --format='value(projectNumber)')
   SA="${PN}-compute@developer.gserviceaccount.com"
   gcloud iam service-accounts add-iam-policy-binding "$SA" \
     --member="serviceAccount:$SA" --role="roles/iam.serviceAccountTokenCreator" --project pioneer-2001-dev
   ```
10. **Deploy the backend to dev:**
    ```bash
    npm install
    npm run deploy:dev        # rules, indexes, storage rules, functions → pioneer-2001-dev only
    ```
11. **Seed reference data.** This adds the Travelers carrier, the Unassigned broker, and default settings with AI off. It creates no clients or policies.
    ```bash
    gcloud auth application-default login   # once, if Cloud Shell asks
    npm run seed:dev
    ```
12. **Run the app against dev:**
    ```bash
    npm run dev:pioneer-2001-dev
    ```
    Open Cloud Shell **Web Preview → port 5173**. Add the preview's domain (`*.cloudshell.dev`) under Firebase → Authentication → Settings → **Authorized domains** in **pioneer-2001-dev**. Sign in, then click **Activate owner access**.

## Local emulators (no cloud at all)

```bash
npm --workspace @asm/functions run build
npx firebase emulators:start --only auth,firestore,functions,storage --project demo-asm
# apps/admin/.env.dev.local → VITE_USE_EMULATORS=true, VITE_FIREBASE_PROJECT_ID=demo-asm
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed-dev.mjs demo-asm
npm run dev:pioneer-2001-dev
```

The AI reader needs a real key and network access, so test it in `pioneer-2001-dev`, not the emulator.
