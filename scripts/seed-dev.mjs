#!/usr/bin/env node
// Seeds the DEVELOPMENT project (or the emulator) with synthetic data only:
//   - reference data for Stage 3A (Travelers carrier, Unassigned broker, default settings)
//   - the Stage 3B synthetic book (carriers, brokers, clients, policies tagged synthetic, IDs SYN3B-…)
//   - one synthetic extracted statement for manual matching tests: SYN3B-MANUAL, created once and then
//     left as you leave it; set SEED_RESET_3B=1 to reset it (refused once it has been approved, posted
//     or reversed: those records are kept; the ledger is never deleted from)
//
//   npm run seed:dev                      (dev project; Application Default Credentials)
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed-dev.mjs demo-asm
//
// It can never seed production. It refuses unless the target is pioneer-2001-dev by ID (.firebaserc
// alias and requested project) AND by project number, as reported by Google for the script's own
// credentials (scripts/lib/dev-guard.mjs).
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { assertDevAlias, assertDevProjectNumber, NotDevError } from './lib/dev-guard.mjs';
import { seedBook, writeStatement } from './lib/synthetic-3b.mjs';

const alias = process.argv[2] ?? 'dev';
let projectId;
try {
  projectId = assertDevAlias(alias);
  const credential = process.env.FIRESTORE_EMULATOR_HOST ? null : applicationDefault();
  await assertDevProjectNumber(projectId, async () => (await credential.getAccessToken()).access_token);
} catch (e) {
  console.error(e instanceof NotDevError ? e.message : `Refusing to seed: ${e.message}`);
  process.exit(1);
}
initializeApp({ projectId });
const db = getFirestore();
const now = FieldValue.serverTimestamp();
const by = 'seed-dev';

async function upsertCarrier(id, data) {
  await db.collection('carriers').doc(id).set({ ...data, createdAt: now, createdBy: by, updatedAt: now, updatedBy: by }, { merge: true });
  await db.collection('carrierCodes').doc(data.code).set({ id });
}
await upsertCarrier('travelers', {
  name: 'Travelers', code: 'TRAV', kind: 'carrier', commissionMethod: 'statement', defaultRateBps: null,
  contact: { name: '', phone: '1-800-842-5075', email: '', address: 'PO Box 2907, Hartford, CT 06104', notes: 'Dev seed' },
  aliases: ['The Travelers'], agencyCodes: [], status: 'active',
});
await db.collection('brokers').doc('UNASSIGNED').set({ name: 'Unassigned', code: 'UNASSIGNED', shareBps: 0, status: 'active', createdAt: now, createdBy: by }, { merge: true });
await db.collection('brokerCodes').doc('UNASSIGNED').set({ id: 'UNASSIGNED' });
const settings = db.collection('settings').doc('app');
if (!(await settings.get()).exists) {
  await settings.set({ agencyName: 'Central Insurance Agency (DEV)', snapshotStartMonth: '2025-01', snapshotMonths: 12, revenueBasis: 'statementPeriod',
    defaultBrokerShareBps: 5000, aiEnabled: false, aiModel: 'claude-sonnet-5-5', aiMonthlyCallLimit: 25, createdAt: now, createdBy: by });
}
await seedBook(db, FieldValue);
const manual = db.collection('statements').doc('SYN3B-MANUAL');
const reset = process.env.SEED_RESET_3B === '1';
if (reset || !(await manual.get()).exists) await writeStatement(db, FieldValue, 'SYN3B-MANUAL', 'Stage 3B manual test statement');
console.log(`Seeded ${projectId}: Travelers carrier, Unassigned broker, default settings; Stage 3B synthetic book; SYN3B-MANUAL ${reset ? 'reset' : 'present'}.`);
