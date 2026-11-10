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
    await setDoc(doc(db, 'policies/SYN-P1/terms/2025-07-02'), { effectiveDate: '2025-07-02', scheduledExpirationDate: '2026-07-03', status: 'renewed' });
    await setDoc(doc(db, 'brokerAdvances/SYN-ADV1'), { policyId: 'SYN-P1', brokerId: 'SYN-B1', amountPaidCents: 50000, status: 'active' });
    await setDoc(doc(db, 'advanceImports/SYN-IMP1'), { status: 'staged' });
    await setDoc(doc(db, 'advanceImports/SYN-IMP1/rows/00002'), { ok: true });
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
  it('Stage 3C: only the server posts — the browser cannot create, edit, reverse or delete ledger entries or approve/post statements', async () => {
    await assertSucceeds(getDoc(doc(staff(), 'ledger/SYN-L1')));
    await assertFails(setDoc(doc(admin(), 'ledger/SYN-S1__p1__00001'), { amountCents: 100, postingStatus: 'posted', statementPeriod: '2026-10' }));
    await assertFails(setDoc(doc(admin(), 'ledger/SYN-L1'), { postingStatus: 'reversed' }, { merge: true }));
    await assertFails(setDoc(doc(admin(), 'ledger/SYN-L1__rev'), { amountCents: -100, reversalOf: 'SYN-L1' }));
    await assertFails(deleteDoc(doc(admin(), 'ledger/SYN-L1')));
    await assertFails(setDoc(doc(admin(), 'statements/SYN-S1'), { status: 'approved' }, { merge: true }));
    await assertFails(setDoc(doc(admin(), 'statements/SYN-S1'), { status: 'posted', postedCents: 100 }, { merge: true }));
    await assertFails(setDoc(doc(staff(), 'ledger/retained__x'), { sourceType: 'retained', amountCents: 1 }));
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

describe('policy coverage terms', () => {
  it('admin and staff can read term history; other roles and signed-out users cannot', async () => {
    await assertSucceeds(getDocs(collection(staff(), 'policies/SYN-P1/terms')));
    await assertSucceeds(getDoc(doc(admin(), 'policies/SYN-P1/terms/2025-07-02')));
    await assertFails(getDoc(doc(buyerLike(), 'policies/SYN-P1/terms/2025-07-02')));
    await assertFails(getDoc(doc(noRole(), 'policies/SYN-P1/terms/2025-07-02')));
    await assertFails(getDoc(doc(anon(), 'policies/SYN-P1/terms/2025-07-02')));
  });
  it('terms are written only by server functions (validated, audited), never from the browser', async () => {
    await assertFails(setDoc(doc(admin(), 'policies/SYN-P1/terms/2026-07-03'), { effectiveDate: '2026-07-03', status: 'active' }));
    await assertFails(setDoc(doc(admin(), 'policies/SYN-P1/terms/2025-07-02'), { status: 'cancelled' }, { merge: true }));
    await assertFails(deleteDoc(doc(admin(), 'policies/SYN-P1/terms/2025-07-02')));
    await assertFails(setDoc(doc(staff(), 'policies/SYN-P1/terms/2026-07-03'), { effectiveDate: '2026-07-03' }));
  });
});

describe('broker buyout data (owner only)', () => {
  it('only admin can read advance payments and advance imports', async () => {
    await assertSucceeds(getDoc(doc(admin(), 'brokerAdvances/SYN-ADV1')));
    await assertSucceeds(getDocs(collection(admin(), 'advanceImports/SYN-IMP1/rows')));
    for (const ctx of [staff, buyerLike, noRole, anon]) {
      await assertFails(getDoc(doc(ctx(), 'brokerAdvances/SYN-ADV1')));
      await assertFails(getDocs(collection(ctx(), 'brokerAdvances')));
      await assertFails(getDoc(doc(ctx(), 'advanceImports/SYN-IMP1')));
      await assertFails(getDoc(doc(ctx(), 'advanceImports/SYN-IMP1/rows/00002')));
    }
  });
  it('no browser can create, change or delete advance records, even an admin', async () => {
    await assertFails(setDoc(doc(admin(), 'brokerAdvances/SYN-ADV2'), { amountPaidCents: 1 }));
    await assertFails(setDoc(doc(admin(), 'brokerAdvances/SYN-ADV1'), { amountPaidCents: 1 }, { merge: true }));
    await assertFails(deleteDoc(doc(admin(), 'brokerAdvances/SYN-ADV1')));
    await assertFails(setDoc(doc(admin(), 'advanceImports/SYN-IMP1'), { status: 'committed' }, { merge: true }));
  });
  it('coverage terms can be read across policies (collection group) by staff, not by other roles', async () => {
    const { collectionGroup } = await import('firebase/firestore');
    await assertSucceeds(getDocs(collectionGroup(staff(), 'terms')));
    await assertFails(getDocs(collectionGroup(buyerLike(), 'terms')));
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
