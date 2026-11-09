#!/usr/bin/env node
// Refuses to continue unless the Firebase alias given on the command line points at a
// development project (id ending in "-dev") or a local "demo-" emulator project.
// Used by every dev-only script so they can never run against production (pioneer-285cf).
import { readFileSync, existsSync } from 'node:fs';

const alias = process.argv[2];
if (!alias) { console.error('Usage: assert-dev-target.mjs <firebase alias>'); process.exit(2); }
let projectId = alias;
if (existsSync('.firebaserc')) {
  const rc = JSON.parse(readFileSync('.firebaserc', 'utf8'));
  projectId = rc.projects?.[alias] ?? alias;
}
const ok = /-dev$/.test(projectId) || /^demo-/.test(projectId);
if (!ok || projectId === 'pioneer-285cf') {
  console.error(`Refusing: alias "${alias}" resolves to "${projectId}", which is not a development project.`);
  process.exit(1);
}
console.log(`OK: target is development project "${projectId}".`);
