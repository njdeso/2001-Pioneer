#!/usr/bin/env node
// Gate for `npm run deploy:prod`. Production is deployed only:
//   - to pioneer-285cf through the explicit "prod" alias,
//   - from a clean checkout of a commit that is already on origin/main (i.e. merged after review),
//   - with CONFIRM_PRODUCTION_DEPLOY=pioneer-285cf set for this one command,
//   - with functions/.env.pioneer-285cf present (OWNER_EMAILS), so the deploy never stops to ask.
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const PROD = 'pioneer-285cf';
const fail = (m) => { console.error(`Refusing production deploy: ${m}`); process.exit(1); };
const sh = (c) => execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

if (process.env.CONFIRM_PRODUCTION_DEPLOY !== PROD) fail(`set CONFIRM_PRODUCTION_DEPLOY=${PROD} for this command.`);
const rc = existsSync('.firebaserc') ? JSON.parse(readFileSync('.firebaserc', 'utf8')) : {};
if (rc.projects?.prod !== PROD) fail(`.firebaserc alias "prod" must be ${PROD}.`);
if (rc.projects?.default) fail('.firebaserc must not define a "default" project.');
if (!existsSync(`functions/.env.${PROD}`)) fail(`functions/.env.${PROD} is missing (copy functions/.env.${PROD}.example and set OWNER_EMAILS).`);
if (sh('git status --porcelain --untracked-files=no')) fail('the working tree has uncommitted changes.');
sh('git fetch --quiet origin main');
try { sh('git merge-base --is-ancestor HEAD origin/main'); } catch { fail('HEAD is not on origin/main. Merge the reviewed pull requests first, then deploy from main.'); }
console.log(`OK: deploying commit ${sh('git rev-parse --short HEAD')} (on origin/main) to ${PROD}.`);
