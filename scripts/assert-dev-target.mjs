#!/usr/bin/env node
// Refuses to continue unless the Firebase alias resolves to the development project
// (pioneer-2001-dev) or a local "demo-" emulator project. Every dev-only script runs this
// first, so none of them can ever run against production (pioneer-285cf).
import { readFileSync, existsSync } from 'node:fs';

const DEV_PROJECT_ID = 'pioneer-2001-dev';
const PROD_PROJECT_ID = 'pioneer-285cf';

const alias = process.argv[2];
if (!alias) { console.error('Usage: assert-dev-target.mjs <firebase alias>'); process.exit(2); }
let projectId = alias;
if (existsSync('.firebaserc')) {
  const rc = JSON.parse(readFileSync('.firebaserc', 'utf8'));
  if (rc.projects?.default) {
    console.error('Refusing: .firebaserc must not define a "default" project; use explicit aliases (dev / prod).');
    process.exit(1);
  }
  projectId = rc.projects?.[alias] ?? alias;
}
const ok = projectId === DEV_PROJECT_ID || /^demo-/.test(projectId);
if (!ok || projectId === PROD_PROJECT_ID) {
  console.error(`Refusing: alias "${alias}" resolves to "${projectId}", which is not the development project (${DEV_PROJECT_ID}).`);
  process.exit(1);
}
console.log(`OK: target is development project "${projectId}".`);
