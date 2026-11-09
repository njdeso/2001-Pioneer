#!/usr/bin/env node
// Seeds a DEVELOPMENT project (or the emulator) with the minimum reference data for
// Stage 3A testing. Synthetic/reference data only — no clients, policies or commissions.
//   npm run seed:dev                      (dev project, uses Application Default Credentials)
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed-dev.mjs demo-asm
import { readFileSync, existsSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const alias = process.argv[2] ?? 'dev';
const rc = existsSync('.firebaserc') ? JSON.parse(readFileSync('.firebaserc', 'utf8')) : {};
const projectId = rc.projects?.[alias] ?? alias;
if (!(projectId === 'pioneer-2001-dev' || /^demo-/.test(projectId)) || projectId === 'pioneer-285cf') {
  console.error(`Refusing to seed "${projectId}": not a development project.`);
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
console.log(`Seeded ${projectId}: Travelers carrier, Unassigned broker, default settings.`);
