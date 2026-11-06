import { useState, type FormEvent } from 'react';
import { sendPasswordResetEmail, signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../firebase';
import { api } from '../api';
import { useAuth } from '../auth';
import { Button, ErrorNote, Field, TextInput } from '../ui';
import { Footer } from '../layout';

export function LoginPage() {
  const { user, refresh, logout } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch {
      setError('Sign-in failed. Check your email and password.');
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    setBusy(true); setError(null);
    try {
      await api.claimOwner();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not activate owner access.');
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!email.trim()) { setError('Enter your email first.'); return; }
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setNotice('If that account exists, a reset link has been sent.');
    } catch {
      setNotice('If that account exists, a reset link has been sent.');
    }
  }

  return (
    <div className="flex min-h-full flex-col bg-gradient-to-br from-ink to-ink-2">
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm rounded-xl bg-white p-7 shadow-2xl">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-ink text-lg font-bold text-gold">A</div>
            <h1 className="text-lg font-semibold text-ink">Agency Sale Manager</h1>
            <p className="text-xs text-slate-500">by Vudu Tech</p>
          </div>

          {user ? (
            <div className="space-y-3 text-sm">
              <p className="text-slate-600">Signed in as <span className="font-medium">{user.email}</span>, but this account has no access role yet.</p>
              <p className="text-slate-500">If this is the owner account, activate it once:</p>
              <ErrorNote message={error} />
              <Button className="w-full" disabled={busy} onClick={() => void claim()}>{busy ? 'Activating…' : 'Activate owner access'}</Button>
              <Button className="w-full" variant="secondary" onClick={() => void logout()}>Sign out</Button>
            </div>
          ) : (
            <form onSubmit={(e) => void submit(e)} className="space-y-4">
              <Field label="Email">
                <TextInput type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </Field>
              <Field label="Password">
                <TextInput type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
              <ErrorNote message={error} />
              {notice && <p className="text-xs text-emerald-700">{notice}</p>}
              <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
              <button type="button" onClick={() => void reset()} className="block w-full text-center text-xs text-slate-500 hover:text-ink">Forgot password?</button>
            </form>
          )}
          <p className="mt-6 text-center text-[11px] text-slate-400">Confidential agency financial records. Authorized users only.</p>
        </div>
      </div>
      <div className="bg-white/95"><Footer /></div>
    </div>
  );
}
