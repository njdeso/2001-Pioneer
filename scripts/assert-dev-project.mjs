#!/usr/bin/env node
// Pre-deploy check (GitHub Actions, after Google sign-in): Google must confirm that the deploy target
// is pioneer-2001-dev with project number 994437988131, using the deployer's own credentials.
// Fails the workflow before anything is deployed if not.
import { applicationDefault } from 'firebase-admin/app';
import { assertDevAlias, assertDevProjectNumber, DEV_PROJECT_NUMBER } from './lib/dev-guard.mjs';

try {
  const projectId = assertDevAlias('dev');
  const credential = applicationDefault();
  await assertDevProjectNumber(projectId, async () => (await credential.getAccessToken()).access_token);
  console.log(`Google confirms the target: ${projectId}, project number ${DEV_PROJECT_NUMBER}.`);
} catch (e) {
  console.error(`::error::${e.message}`);
  process.exit(1);
}
