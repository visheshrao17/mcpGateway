import { useCallback, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import { Loader } from 'lucide-react';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { useAction, useResource } from '@/hooks';
import { InlineError } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { absoluteTime } from '@/lib/format';

export function LoginPage() {
  const { user, setUser } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const action = useAction();
  const destination: string = location.state?.from ?? '/servers';
  if (user) return <Navigate to={destination} replace />;
  function submit(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      const result = await api.login(email.trim(), password);
      setUser(result.user);
    });
  }
  return (
    <AuthShell title="Sign in" description="Manage your MCP servers, keys and tool access.">
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" aria-invalid={!!action.error || undefined} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} aria-invalid={!!action.error || undefined} />
        </div>
        <InlineError message={action.error} />
        <Button type="submit" size="lg" className="w-full" disabled={action.busy}>
          {action.busy && <Loader className="animate-spin" />}
          {action.busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="mt-5 text-center text-[12.5px] text-muted-foreground">Need access? Ask your administrator for an invite.</p>
    </AuthShell>
  );
}

export function InvitePage() {
  const { token = '' } = useParams();
  const { setUser } = useAuth();
  const [accepted, setAccepted] = useState(false);
  const invite = useResource(useCallback(() => api.invite(token), [token]));
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const action = useAction();
  if (accepted) return <Navigate to="/servers" replace />;
  function submit(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      const result = await api.acceptInvite(token, name.trim(), password);
      setUser(result.user);
      setAccepted(true);
    });
  }
  const tooShort = password.length > 0 && password.length < 10;
  return (
    <AuthShell title="Join your team" description="Create your account to start using the gateway.">
      {invite.loading && !invite.data && (
        <div className="grid gap-3" role="status" aria-label="Loading invitation">
          <Skeleton className="h-14" /><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" />
        </div>
      )}
      {invite.error && <InlineError message={invite.error.includes('not found') ? 'This invitation link is invalid, has expired or was already used.' : invite.error} />}
      {invite.data && (
        <form onSubmit={submit} className="grid gap-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/60 px-3.5 py-3">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium">{invite.data.email}</div>
              <div className="text-xs text-muted-foreground">Expires {absoluteTime(invite.data.expires_at)}</div>
            </div>
            <Badge tone={invite.data.role === 'admin' ? 'brand' : 'outline'} className="capitalize">{invite.data.role}</Badge>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="name">Your name</Label>
            <Input id="name" autoComplete="name" required autoFocus value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-password">Password</Label>
            <Input id="new-password" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={e => setPassword(e.target.value)} aria-invalid={tooShort || undefined} aria-describedby="password-hint" />
            <p id="password-hint" className={tooShort ? 'text-xs text-danger-text' : 'text-xs text-muted-foreground'}>At least 10 characters.</p>
          </div>
          <InlineError message={action.error} />
          <Button type="submit" size="lg" className="w-full" disabled={action.busy || !name.trim() || password.length < 10}>
            {action.busy && <Loader className="animate-spin" />}
            {action.busy ? 'Creating account…' : 'Accept invitation'}
          </Button>
        </form>
      )}
      <p className="mt-5 text-center text-[12.5px] text-muted-foreground">
        Already have an account? <Link to="/login" className="font-medium text-foreground underline-offset-4 hover:underline">Sign in</Link>
      </p>
    </AuthShell>
  );
}

function AuthShell({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <main className="relative grid min-h-dvh place-items-center bg-background px-4 py-10">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--brand-soft),transparent_55%)] opacity-60" />
      <div className="relative w-full max-w-[380px]">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <div className="grid size-8 place-items-center rounded-lg bg-foreground text-[16px] font-semibold text-background">u</div>
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-[-0.01em]">urumi</div>
            <div className="text-xs text-muted-foreground">MCP gateway</div>
          </div>
        </div>
        <section className="rounded-xl border bg-card p-6 shadow-xs sm:p-7">
          <h1 className="text-lg font-semibold tracking-[-0.015em]">{title}</h1>
          <p className="mb-5 mt-1 text-[13px] text-muted-foreground">{description}</p>
          {children}
        </section>
      </div>
    </main>
  );
}
