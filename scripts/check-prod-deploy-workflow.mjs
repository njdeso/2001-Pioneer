#!/usr/bin/env node
// CI check: the production deploy workflow stays inside its limits. Fails the build if it gains an automatic
// trigger, leaves main / the "production" environment, deploys anything but the two target functions, uses
// --force or a key, or reads a secret value. Local files only; no credentials.
import { readFileSync, readdirSync } from 'node:fs';

const path = '.github/workflows/deploy-prod-functions.yml';
const wf = readFileSync(path, 'utf8');
const code = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const errors = [];
const need = (cond, msg) => { if (!cond) errors.push(msg); };

const onBlock = (/^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(code) ?? [])[1] ?? '';
const triggers = [...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
need(triggers.length === 1 && triggers[0] === 'workflow_dispatch', `only workflow_dispatch may trigger it (found: ${triggers.join(', ') || 'none'})`);
need(/if: github\.ref == 'refs\/heads\/main' && github\.event_name == 'workflow_dispatch'/.test(code), 'job must be restricted to main and workflow_dispatch');
need(/^\s+environment: production$/m.test(code), 'job must use the protected "production" environment');
need(/dry_run:[\s\S]*?default: true/.test(code), 'dry_run must default to true');
need(/^\s+PROD_PROJECT_ID: pioneer-285cf$/m.test(code) && /project_id: pioneer-285cf/.test(code), 'must target pioneer-285cf');
need(/^\s+TARGET_FUNCTIONS: processStatement,setStatementPayer$/m.test(code), 'TARGET_FUNCTIONS must be processStatement,setStatementPayer');
need(/^\s+EXPECTED_COMMIT: [0-9a-f]{40}$/m.test(code), 'EXPECTED_COMMIT must be a full commit hash');

const deploys = [...code.matchAll(/firebase deploy[^\n]*/g)].map((m) => m[0]);
need(deploys.length === 1, `exactly one firebase deploy command (found ${deploys.length})`);
need(deploys[0] === 'firebase deploy --project prod --only "functions:processStatement,functions:setStatementPayer" --non-interactive', `the deploy command must deploy only the two functions (found: ${deploys[0]})`);
need(!/--force/.test(code), 'must never use --force');
need(!/firestore:|storage:|--only[^\n]*(firestore|storage|hosting|database|remoteconfig|extensions)/.test(code), 'must not deploy rules, indexes or other products');
need(!/functions:delete|firebase functions:secrets:set|secrets:access|versions access|secrets versions access/.test(code), 'must not delete functions or read/set secret values');
need(!/credentials_json|GOOGLE_CREDENTIALS|service_account_key/.test(code), 'must not use a service-account key');
need(/workload_identity_provider: \$\{\{ vars\.GCP_PROD_WIF_PROVIDER \}\}/.test(code), 'must authenticate with the WIF provider variable');
need(/^permissions:\n\s+contents: read\n\s+id-token: write/m.test(code), 'permissions must be contents: read and id-token: write only');
need(/if: env\.DRY_RUN != 'true'/.test(code), 'the deploy step must be skipped in a dry run');
need(!/upload-artifact[\s\S]*?path: [^\n]*(before|after)\.json/.test(code), 'raw snapshots (they hold variable values) must never be uploaded');

// Only read-only Firebase CLI commands besides the one deploy.
const fbCmds = [...code.matchAll(/firebase ([a-z:]+)/g)].map((m) => m[1]).filter((c) => c !== 'deploy');
need(fbCmds.every((c) => ['functions:list', 'functions:secrets:get'].includes(c)), `only read-only Firebase CLI commands are allowed besides the deploy (found: ${fbCmds.join(', ')})`);

// No other workflow may use the production environment, its variables, or call this workflow.
for (const f of readdirSync('.github/workflows').filter((n) => /\.ya?ml$/.test(n))) {
  if (`.github/workflows/${f}` === path) continue;
  const other = readFileSync(`.github/workflows/${f}`, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  need(!/environment:\s*['"]?production\b/.test(other), `${f} must not use the production environment`);
  need(!/GCP_PROD_/.test(other), `${f} must not use the GCP_PROD_ variables`);
  need(!/deploy-prod-functions\.yml/.test(other), `${f} must not call or reference the production deploy workflow`);
  need(!/pioneer-285cf/.test(other.replace(/^\s*#.*$/gm, '')), `${f} must not target pioneer-285cf`);
}

if (errors.length) {
  console.error('Production deploy workflow check FAILED:\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log('Production deploy workflow check passed (manual, main only, production environment, two functions, no --force, no key).');
