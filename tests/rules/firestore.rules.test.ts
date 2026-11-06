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

describe('storage', () => {
  it('storage is closed to the browser in Phase 1', async () => {
    const s = env.authenticatedContext('admin1', { role: 'admin' }).storage();
    await assertFails(uploadString(ref(s, 'incoming/x.pdf'), 'data'));
    await assertFails(getBytes(ref(s, 'statements/x.pdf')));
  });
});
