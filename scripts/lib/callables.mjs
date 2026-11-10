// The Cloud Functions this codebase exports (all are Firebase callables), read from functions/src/index.ts.
// Used by the dev deploy to make sure each one accepts calls from the browser, and by the smoke test to
// check that from the browser's point of view (CORS preflight + unauthenticated POST).
import { readFileSync } from 'node:fs';

export function exportedCallables(indexPath = 'functions/src/index.ts') {
  const src = readFileSync(indexPath, 'utf8');
  const names = [];
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}\s*from/gm)) {
    for (const n of m[1].split(',')) { const name = n.trim().split(/\s+as\s+/).pop(); if (name) names.push(name); }
  }
  for (const m of src.matchAll(/^export\s+const\s+(\w+)/gm)) names.push(m[1]);
  return [...new Set(names)].sort();
}

/** Cloud Run service name of a 2nd-gen function (lower-case function name). */
export const serviceName = (fn) => fn.toLowerCase();

if (import.meta.url === `file://${process.argv[1]}`) console.log(exportedCallables().join('\n'));
