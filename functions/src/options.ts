import { setGlobalOptions } from 'firebase-functions/v2';

/**
 * Global function options. This module must be the FIRST import in index.ts: ES modules evaluate
 * imported modules before the importing file's own code, and each onCall() captures the global
 * options when it is defined. (Calling setGlobalOptions in the body of index.ts ran after every
 * function was defined, so it was silently ignored and functions deployed to the default region.)
 *
 * Region: us-central1 is where every 2001-Pioneer function has been deployed so far, in dev and
 * production, so keeping it changes no deployed URL. Moving region is a separate migration (deploy
 * the new region, switch VITE_FUNCTIONS_REGION, then remove the old functions).
 * Checked in CI by scripts/check-functions-endpoints.mjs.
 */
export const FUNCTIONS_REGION = 'us-central1';

setGlobalOptions({ region: FUNCTIONS_REGION, maxInstances: 5 });
