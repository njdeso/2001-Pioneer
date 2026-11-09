/**
 * Security rules tests. Run against the Firestore emulator:
 *   npm run test:rules
 * (wraps: firebase emulators:exec --only firestore,storage "vitest run tests/rules")
 * All data here is synthetic.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';
import { ref, uploadString, getBytes } from 'firebase/storage';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-asm-rules',
    firestore: { rules: readFileSync('firebase/firestore.rules', 'utf8') },
    storage: { rules: readFileSync('firebase/storage.rules', 'utf8') },
  });
});

afterAll(async () => env?.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'clients/SYN-C1'), { name: 'Synthetic Client One' });
    await setDoc(doc(db, 'policies/SYN-P1'), { policyNumber: 'SYN-100' });
    await setDoc(doc(db, 'ledger/SYN-L1'), { amountCents: 12345 });
    await setDoc(doc(db, 'auditLog/SYN-A1'), { action: 'create' });
    await setDoc(doc(db, 'policyKeys/k__SYN100'), { policyId: 'SYN-P1' });
    await setDoc(doc(db, 'users/admin1'), { role: 'admin' });
  });
});

const admin = () => env.authenticatedContext('admin1', { role: 'admin', email: 'owner@example.test' }).firestore();
const staff = () => env.authenticatedContext('staff1', { role: 'staff' }).firestore();
const noRole = () => env.authenticatedContext('rando', {}).firestore();
const buyerLike = () => env.authenticatedContext('buyer1', { role: 'buyer' }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

describe('reads', () => {
  it('admin and staff can read business data', async () => {
    await assertSucceeds(getDoc(doc(admin(), 'clients/SYN-C1')));
    await assertSucceeds(getDoc(doc(staff(), 'policies/SYN-P1')));
    await assertSucceeds(getDocs(collection(staff(), 'ledger')));
  });
  it('signed-in users without a role, unknown roles and anonymous users cannot read', async () => {
    await assertFails(getDoc(doc(noRole(), 'clients/SYN-C1')));
    await assertFails(getDoc(doc(buyerLike(), 'ledger/SYN-L1')));
    await assertFails(getDoc(doc(anon(), 'clients/SYN-C1')));
  });
  it('only admin can read the audit log', async () => {
    await assertSucceeds(getDoc(doc(admin(), 'auditLog/SYN-A1')));
    await assertFails(getDoc(doc(staff(), 'auditLog/SYN-A1')));
  });
  it('uniqueness keys are server-only', async () => {
    await assertFails(getDoc(doc(admin(), 'policyKeys/k__SYN100')));
  });
  it('users can read only their own profile', async () => {
    await assertSucceeds(getDoc(doc(admin(), 'users/admin1')));
    await assertFails(getDoc(doc(staff(), 'users/admin1')));
  });
});

describe('writes', () => {
  it('nobody can write from the browser, including admin', async () => {
    await assertFails(setDoc(doc(admin(), 'clients/NEW'), { name: 'x' }));
    await assertFails(setDoc(doc(admin(), 'ledger/NEW'), { amountCents: 1 }));
    await assertFails(setDoc(doc(admin(), 'ledger/SYN-L1'), { amountCents: 99999 }));
    await assertFails(deleteDoc(doc(admin(), 'ledger/SYN-L1')));
    await assertFails(setDoc(doc(admin(), 'auditLog/NEW'), { action: 'forged' }));
    await assertFails(setDoc(doc(admin(), 'users/admin1'), { role: 'admin' }));
  });
});

describe('imports', () => {
  it('staff can read import batches but nobody can write them from the browser', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'importBatches/SYN-B1'), { status: 'committed' });
      await setDoc(doc(ctx.firestore(), 'importBatches/SYN-B1/rows/000002'), { rowNumber: 2 });
    });
    await assertSucceeds(getDoc(doc(staff(), 'importBatches/SYN-B1')));
    await assertSucceeds(getDoc(doc(staff(), 'importBatches/SYN-B1/rows/000002')));
    await assertFails(setDoc(doc(admin(), 'importBatches/SYN-B1'), { status: 'staged' }));
    await assertFails(getDoc(doc(noRole(), 'importBatches/SYN-B1')));
  });
});

describe('statements (Firestore)', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'statements/SYN-S1'), { status: 'needs_review' });
      await setDoc(doc(db, 'statements/SYN-S1/lines/00001'), { paidCommissionCents: 100 });
      await setDoc(doc(db, 'extractionRuns/SYN-R1'), { ok: true });
      await setDoc(doc(db, 'aiUsage/2026-11'), { calls: 1 });
      await setDoc(doc(db, 'statementKeys/abc'), { statementId: 'SYN-S1' });
    });
  });
  it('admin and staff can read statements and lines; nobody can write them', async () => {
    await assertSucceeds(getDoc(doc(staff(), 'statements/SYN-S1')));
    await assertSucceeds(getDoc(doc(staff(), 'statements/SYN-S1/lines/00001')));
    await assertFails(setDoc(doc(admin(), 'statements/SYN-S1'), { status: 'posted' }));
    await assertFails(setDoc(doc(admin(), 'statements/SYN-S1/lines/00001'), { paidCommissionCents: 999 }));
    await assertFails(getDoc(doc(noRole(), 'statements/SYN-S1')));
  });
  it('Stage 3B: match results and the matching summary are server-only, even for admin', async () => {
    const matchedLine = { paidCommissionCents: 100, match: { status: 'matched', method: 'manual', policyId: 'SYN-P1' } };
    await assertSucceeds(getDoc(doc(staff(), 'statements/SYN-S1/lines/00001')));
    // A browser cannot set, change or clear a match, or rewrite the extracted values beside it.
    await assertFails(setDoc(doc(admin(), 'statements/SYN-S1/lines/00001'), matchedLine));
    await assertFails(setDoc(doc(admin(), 'statements/SYN-S1/lines/00001'), { match: { status: 'unmatched' } }, { merge: true }));
    await assertFails(setDoc(doc(staff(), 'statements/SYN-S1/lines/00001'), { match: null }, { merge: true }));
    await assertFails(deleteDoc(doc(admin(), 'statements/SYN-S1/lines/00001')));
    await assertFails(setDoc(doc(admin(), 'statements/SYN-S1'), { matching: { matched: 99 } }, { merge: true }));
    // Matching never needs browser writes to clients, policies or the ledger either.
    await assertFails(setDoc(doc(admin(), 'policies/SYN-P1'), { brokerId: 'X' }, { merge: true }));
    await assertFails(setDoc(doc(admin(), 'ledger/SYN-L2'), { amountCents: 1 }));
  });
  it('extraction runs and AI usage are admin-read-only; fingerprint keys are server-only', async () => {
    await assertSucceeds(getDoc(doc(admin(), 'extractionRuns/SYN-R1')));
    await assertFails(getDoc(doc(staff(), 'extractionRuns/SYN-R1')));
    await assertSucceeds(getDoc(doc(admin(), 'aiUsage/2026-11')));
    await assertFails(setDoc(doc(admin(), 'aiUsage/2026-11'), { calls: 0 }));
    await assertFails(getDoc(doc(admin(), 'statementKeys/abc')));
  });
});

describe('storage', () => {
  const pdf = { contentType: 'application/pdf' };
  it('an admin can create an upload only in their own incoming folder', async () => {
    const s = env.authenticatedContext('admin1', { role: 'admin' }).storage();
    await assertSucceeds(uploadString(ref(s, 'incoming/admin1/SYN-S1/upload.pdf'), '%PDF-1.4 synthetic', 'raw', pdf));
    await assertFails(uploadString(ref(s, 'incoming/someone-else/SYN-S1/upload.pdf'), '%PDF-1.4', 'raw', pdf));
    await assertFails(uploadString(ref(s, 'incoming/admin1/SYN-S1/evil.exe'), 'MZ', 'raw', { contentType: 'application/octet-stream' }));
    await assertFails(uploadString(ref(s, 'incoming/admin1/SYN-S2/upload.pdf'), 'x', 'raw', { contentType: 'text/html' }));
    await assertFails(uploadString(ref(s, 'statements/SYN-S1/original.pdf'), '%PDF', 'raw', pdf));
  });
  it('uploads cannot be overwritten, read or listed from the browser', async () => {
    const s = env.authenticatedContext('admin1', { role: 'admin' }).storage();
    await assertSucceeds(uploadString(ref(s, 'incoming/admin1/SYN-S3/upload.pdf'), '%PDF-1.4 a', 'raw', pdf));
    await assertFails(uploadString(ref(s, 'incoming/admin1/SYN-S3/upload.pdf'), '%PDF-1.4 b', 'raw', pdf));
    await assertFails(getBytes(ref(s, 'incoming/admin1/SYN-S3/upload.pdf')));
    await assertFails(getBytes(ref(s, 'statements/SYN-S1/original.pdf')));
  });
  it('staff and signed-out users cannot upload', async () => {
    const st = env.authenticatedContext('staff1', { role: 'staff' }).storage();
    await assertFails(uploadString(ref(st, 'incoming/staff1/SYN-S4/upload.pdf'), '%PDF', 'raw', pdf));
    const an = env.unauthenticatedContext().storage();
    await assertFails(uploadString(ref(an, 'incoming/x/SYN-S5/upload.pdf'), '%PDF', 'raw', pdf));
  });
});
