#!/usr/bin/env node
// CI check: the dev deploy workflow, the Workload Identity setup script and .firebaserc must agree.
// Fails the build if any of these values drift apart, or if production appears where it must not.
import { readFileSync } from 'node:fs';

const wf = readFileSync('.github/workflows/deploy-dev.yml', 'utf8');
const sh = readFileSync('scripts/setup-dev-wif.sh', 'utf8');
const rc = JSON.parse(readFileSync('.firebaserc', 'utf8'));
const smoke = readFileSync('scripts/smoke-dev.mjs', 'utf8');
const errors = [];
const need = (cond, msg) => { if (!cond) errors.push(msg); };
const shVar = (name) => (new RegExp(`^${name}="([^"]*)"`, 'm').exec(sh) ?? [])[1];

const DEV = 'pioneer-2001-dev';
const PROD = 'pioneer-285cf';

// Project IDs
need(shVar('PROJECT_ID') === DEV, `setup script PROJECT_ID is ${shVar('PROJECT_ID')}, expected ${DEV}`);
need(shVar('PROD_PROJECT_ID') === PROD, 'setup script must name production only to refuse it');
need(rc.projects?.dev === DEV && rc.projects?.prod === PROD && !rc.projects?.default, '.firebaserc must be dev=pioneer-2001-dev, prod=pioneer-285cf, no default');
need(/DEV_PROJECT_ID: pioneer-2001-dev/.test(wf) && /project_id: pioneer-2001-dev/.test(wf), 'workflow must target pioneer-2001-dev');
const wfCode = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'); // comments may explain; code may not reference prod
need(!wfCode.includes(PROD), 'workflow steps must not reference the production project');
need(/--project dev\b/.test(wf) && !/--project (prod|pioneer-285cf)/.test(wf), 'workflow Firebase commands must use --project dev');
need(smoke.includes(`const DEV = '${DEV}'`), 'smoke test must target pioneer-2001-dev');

// Branch, workflow file, environment
const branch = shVar('DEPLOY_BRANCH');
need(branch === 'deploy/dev', `setup script DEPLOY_BRANCH is ${branch}`);
need(new RegExp(`branches: \\[${branch.replace('/', '\\/')}\\]`).test(wf), 'workflow push trigger must be the deploy branch');
need(wf.includes(`github.ref == 'refs/heads/${branch}'`), 'workflow job must be restricted to the deploy branch');
need(shVar('WORKFLOW_PATH') === '.github/workflows/deploy-dev.yml', 'setup script WORKFLOW_PATH must be this workflow');
need(new RegExp(`environment: ${shVar('GITHUB_ENVIRONMENT')}\\b`).test(wf), `workflow must use environment ${shVar('GITHUB_ENVIRONMENT')}`);

// OIDC permission and keyless auth
need(/^permissions:[\s\S]*?id-token: write/m.test(wf), 'workflow needs permissions: id-token: write');
need(/workload_identity_provider: \$\{\{ vars\.GCP_WIF_PROVIDER \}\}/.test(wf), 'workflow must authenticate with the WIF provider variable');
need(!/credentials_json/.test(wf), 'workflow must not use a service-account key');

// Variable names
need(shVar('VAR_PROVIDER') === 'GCP_WIF_PROVIDER' && wf.includes('vars.GCP_WIF_PROVIDER'), 'provider variable name mismatch');
need(shVar('VAR_SA') === 'GCP_DEV_SERVICE_ACCOUNT' && wf.includes('vars.GCP_DEV_SERVICE_ACCOUNT'), 'service-account variable name mismatch');

// Repository identity
need(shVar('GITHUB_REPO') === 'njdeso/2001-Pioneer', 'setup script GITHUB_REPO mismatch');
need(/^\d+$/.test(shVar('GITHUB_REPO_ID') ?? '') && /^\d+$/.test(shVar('GITHUB_OWNER_ID') ?? ''), 'setup script needs numeric repo and owner IDs');

// Service account domain: workflow accepts only accounts in the dev project
need(wf.includes('*@"$DEV_PROJECT_ID".iam.gserviceaccount.com'), 'workflow must check the service account belongs to the dev project');

// Secret: name agrees with the functions code; the workflow never reads its value
need(shVar('SECRET_NAME') === 'ANTHROPIC_API_KEY', 'setup script secret name must be ANTHROPIC_API_KEY');
need(!/secrets:access|versions access/.test(wf), 'workflow must never read the secret value');

if (errors.length) {
  console.error('Dev deploy configuration check FAILED:\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log('Dev deploy configuration check passed (workflow, setup script, .firebaserc and smoke test agree).');
