#!/usr/bin/env node
// Netlify build for PULL-REQUEST PREVIEWS and BRANCH DEPLOYS only. They always point at the
// development project, pioneer-2001-dev.
//
// The dev Firebase web config comes from Netlify environment variables, never from the repo:
//   DEV_FIREBASE_API_KEY   the pioneer-2001-dev web API key
//   DEV_FIREBASE_APP_ID    the pioneer-2001-dev web app ID (1:994437988131:web:…)
// Set them in Netlify for the "Deploy Previews" and "Branch deploys" contexts only.
//
// No fallback, ever: if a value is missing, belongs to another project, or cannot be verified,
// this script FAILS THE BUILD with an explicit error and nothing is published. It never uses the
// production VITE_FIREBASE_* values set for the production site.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEV_PROJECT_ID = 'pioneer-2001-dev';
export const DEV_PROJECT_NUMBER = '994437988131';
export const PROD_PROJECT_ID = 'pioneer-285cf';
const PREVIEW_CONTEXTS = new Set(['deploy-preview', 'branch-deploy']);

export class PreviewConfigError extends Error {}

/** Validate the environment and return the exact VITE_* values for the dev preview build. */
export async function resolvePreviewEnv(env, fetchImpl = fetch) {
  const fail = (m) => { throw new PreviewConfigError(m); };
  const ctx = env.CONTEXT ?? '';
  if (!PREVIEW_CONTEXTS.has(ctx)) fail(`This build script is only for Netlify previews (CONTEXT deploy-preview or branch-deploy); got "${ctx || 'none'}". Production builds use the normal build command.`);

  const apiKey = (env.DEV_FIREBASE_API_KEY ?? '').trim();
  const appId = (env.DEV_FIREBASE_APP_ID ?? '').trim();
  const missing = [!apiKey && 'DEV_FIREBASE_API_KEY', !appId && 'DEV_FIREBASE_APP_ID'].filter(Boolean);
  if (missing.length) fail(`${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set for the "${ctx}" context in Netlify (Site configuration → Environment variables). The preview was NOT built. It never falls back to the production configuration.`);
  if (!new RegExp(`^1:${DEV_PROJECT_NUMBER}:web:[0-9a-f]+$`).test(appId)) fail(`DEV_FIREBASE_APP_ID is not a ${DEV_PROJECT_ID} web app ID (expected 1:${DEV_PROJECT_NUMBER}:web:…). The preview was NOT built.`);
  if (env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_API_KEY.trim() === apiKey) fail('DEV_FIREBASE_API_KEY equals the VITE_FIREBASE_API_KEY used for production builds. The preview was NOT built.');

  // Ask Firebase Auth which project this API key belongs to. Must be the dev project.
  let projectId = null;
  try {
    const r = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(apiKey)}`, {
      headers: env.DEPLOY_PRIME_URL ? { referer: env.DEPLOY_PRIME_URL } : {},
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) fail(`Firebase rejected DEV_FIREBASE_API_KEY (HTTP ${r.status}${j?.error?.message ? `: ${j.error.message}` : ''}). The preview was NOT built.`);
    projectId = j.projectId ?? null;
  } catch (e) {
    if (e instanceof PreviewConfigError) throw e;
    fail('Could not verify DEV_FIREBASE_API_KEY with Firebase (network error). The preview was NOT built.');
  }
  if (projectId !== DEV_PROJECT_ID) fail(`DEV_FIREBASE_API_KEY belongs to project "${projectId ?? 'unknown'}", not ${DEV_PROJECT_ID}. The preview was NOT built.`);

  return {
    VITE_FIREBASE_API_KEY: apiKey,
    VITE_FIREBASE_APP_ID: appId,
    VITE_FIREBASE_PROJECT_ID: DEV_PROJECT_ID,
    VITE_FIREBASE_AUTH_DOMAIN: `${DEV_PROJECT_ID}.firebaseapp.com`,
    VITE_FIREBASE_STORAGE_BUCKET: `${DEV_PROJECT_ID}.firebasestorage.app`,
    VITE_FUNCTIONS_REGION: 'us-central1',
    VITE_USE_EMULATORS: 'false',
    VITE_DEPLOY_CONTEXT: ctx,
  };
}

async function main() {
  let vite;
  try {
    vite = await resolvePreviewEnv(process.env);
  } catch (e) {
    console.error(`\n✗ Dev preview build refused: ${e.message}\n`);
    process.exit(1);
  }
  console.log(`Dev preview build → ${vite.VITE_FIREBASE_PROJECT_ID} (app ${vite.VITE_FIREBASE_APP_ID}), context ${vite.VITE_DEPLOY_CONTEXT}. API key verified with Firebase.`);
  // Explicit values override anything inherited (including production VITE_* values from the UI).
  const r = spawnSync('npm', ['--workspace', '@asm/admin', 'run', 'build'], { stdio: 'inherit', env: { ...process.env, ...vite } });
  process.exit(r.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
