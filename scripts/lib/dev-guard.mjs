// Shared guard for every script that WRITES data (seed, smoke test). It refuses unless the target is
// the development project, checked two independent ways:
//   1. by ID: the .firebaserc "dev" alias and the requested project must both be pioneer-2001-dev, and
//      neither may be production;
//   2. by project NUMBER: Google, asked with the script's own credentials, must report project number
//      994437988131 for the target. A renamed alias, a typo or production credentials cannot pass this.
import { readFileSync, existsSync } from 'node:fs';

export const DEV_PROJECT_ID = 'pioneer-2001-dev';
export const DEV_PROJECT_NUMBER = '994437988131';
export const PROD_PROJECT_ID = 'pioneer-285cf';

export class NotDevError extends Error {}

/** Synchronous checks (no network): alias and requested project. Returns the project ID. */
export function assertDevAlias(aliasOrId = 'dev') {
  const rc = existsSync('.firebaserc') ? JSON.parse(readFileSync('.firebaserc', 'utf8')) : {};
  if (rc.projects?.default) throw new NotDevError('.firebaserc must not define a "default" project.');
  const projectId = rc.projects?.[aliasOrId] ?? aliasOrId;
  if (/^demo-/.test(projectId)) return projectId; // local emulator only
  if (projectId !== DEV_PROJECT_ID || projectId === PROD_PROJECT_ID) {
    throw new NotDevError(`Refusing: "${aliasOrId}" resolves to "${projectId}", not the development project ${DEV_PROJECT_ID}.`);
  }
  if (rc.projects?.dev !== DEV_PROJECT_ID) throw new NotDevError(`Refusing: .firebaserc "dev" alias is "${rc.projects?.dev}", expected ${DEV_PROJECT_ID}.`);
  return projectId;
}

/**
 * Ask Google which project the target really is, using the caller's credentials.
 * `getAccessToken` returns an OAuth access token (firebase-admin credential or similar).
 */
export async function assertDevProjectNumber(projectId, getAccessToken, fetchImpl = fetch) {
  if (/^demo-/.test(projectId) && process.env.FIRESTORE_EMULATOR_HOST) return; // emulator: nothing real to protect
  if (/^demo-/.test(projectId)) throw new NotDevError('demo- projects are only allowed against the emulator (FIRESTORE_EMULATOR_HOST).');
  const token = await getAccessToken();
  const r = await fetchImpl(`https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}`, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new NotDevError(`Refusing: could not confirm the target project (HTTP ${r.status} ${j?.error?.message ?? ''}).`);
  if (String(j.projectNumber) !== DEV_PROJECT_NUMBER || j.projectId !== DEV_PROJECT_ID) {
    throw new NotDevError(`Refusing: target is project ${j.projectId} (number ${j.projectNumber}), not ${DEV_PROJECT_ID} (number ${DEV_PROJECT_NUMBER}).`);
  }
}
