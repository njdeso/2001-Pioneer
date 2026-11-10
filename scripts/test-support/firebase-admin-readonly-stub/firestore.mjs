// Test stub for firebase-admin/firestore: serves a JSON fixture and THROWS on any write method, so a
// test run proves the audit script performs reads only. Used by scripts/audit-dev-ledger.test.mjs.
import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync(process.env.STUB_DATA, 'utf8'));
const ts = (v) => (v && v.__ts ? { toDate: () => new Date(v.__ts) } : v);
const docOf = (id, d) => ({ id, exists: !!d, data: () => d && Object.fromEntries(Object.entries(d).map(([k, v]) => [k, ts(v)])) });
const write = (what) => () => { throw new Error(`WRITE ATTEMPTED: ${what}`); };
const docRef = (c, id) => ({ get: async () => docOf(id, data[c]?.[id]), set: write('set'), update: write('update'), delete: write('delete'), create: write('create'), collection: write('subcollection') });
export const getFirestore = () => ({
  collection: (n) => ({ get: async () => ({ docs: Object.entries(data[n] ?? {}).map(([id, d]) => docOf(id, d)) }), add: write('add'), doc: (id) => docRef(n, id) }),
  doc: (p) => { const [c, id] = p.split('/'); return docRef(c, id); },
  batch: write('batch'), runTransaction: write('runTransaction'), bulkWriter: write('bulkWriter'), recursiveDelete: write('recursiveDelete'),
});
export const FieldValue = new Proxy({}, { get: () => write('FieldValue') });
