import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { onIdTokenChanged, signOut, type User } from 'firebase/auth';
import type { Role } from '@asm/shared';
import { auth } from './firebase';

interface AuthState {
  loading: boolean;
  user: User | null;
  role: Role | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const IDLE_LIMIT_MS = 30 * 60 * 1000; // sign out after 30 minutes without activity

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(
    () =>
      onIdTokenChanged(auth, async (u) => {
        setUser(u);
        if (u) {
          const token = await u.getIdTokenResult();
          const r = token.claims.role;
          setRole(r === 'admin' || r === 'staff' ? r : null);
        } else {
          setRole(null);
        }
        setLoading(false);
      }),
    [],
  );

  // Idle timeout for secure session management.
  useEffect(() => {
    if (!user) return;
    let timer = window.setTimeout(() => void signOut(auth), IDLE_LIMIT_MS);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void signOut(auth), IDLE_LIMIT_MS);
    };
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [user]);

  const value: AuthState = {
    loading,
    user,
    role,
    refresh: async () => {
      if (auth.currentUser) await auth.currentUser.getIdToken(true);
    },
    logout: () => signOut(auth),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
