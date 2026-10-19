import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, api } from './api';
import { errorMessage } from './hooks';
import type { User } from './types';
import { Loader, Unplug } from 'lucide-react';
import { Button } from './components/ui/button';

const AuthContext = createContext<{ user: User | null; setUser: (user: User | null) => void } | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const expired = () => setUser(null);
    window.addEventListener('session-expired', expired);
    setLoading(true);
    api.me().then(result => { if (active) { setUser(result.user); setError(''); } })
      .catch(err => {
        if (active) {
          if (err instanceof ApiError && err.status === 401) { setUser(null); setError(''); }
          else setError(errorMessage(err));
        }
      }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; window.removeEventListener('session-expired', expired); };
  }, [attempt]);
  if (loading) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background text-muted-foreground" role="status">
        <span className="flex items-center gap-2 text-[13px]"><Loader className="size-4 animate-spin" />Loading your session…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background p-4">
        <div className="w-full max-w-sm rounded-xl border bg-card p-6 text-center">
          <div className="mx-auto mb-3 grid size-10 place-items-center rounded-lg border bg-muted text-muted-foreground"><Unplug className="size-[18px]" /></div>
          <h1 className="text-base font-semibold">Cannot reach the gateway</h1>
          <p role="alert" className="mt-1 text-[13px] text-muted-foreground">{error}</p>
          <Button className="mt-4" onClick={() => setAttempt(value => value + 1)}>Try again</Button>
        </div>
      </div>
    );
  }
  return <AuthContext.Provider value={{ user, setUser }}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('Auth provider is missing');
  return context;
}
