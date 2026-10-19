import { useState } from 'react';
import type { FormEvent } from 'react';
import { Ellipsis, Loader, Mail, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { errorMessage, useResource } from '@/hooks';
import { PageContainer } from '@/components/app-shell';
import { CodeBlock, EmptyState, InlineError, PageHeader } from '@/components/common';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TabCount, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Hint } from '@/components/ui/tooltip';
import { absoluteTime, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace';
import type { Invite, Member, Role } from '@/types';

type PendingChange = { member: Member; change: { role: Role } | { active: boolean } };

function inviteStatus(invite: Invite, now: number) {
  if (invite.accepted_at) return { label: 'Accepted', tone: 'success' as const };
  if (Date.parse(invite.expires_at) <= now) return { label: 'Expired', tone: 'idle' as const };
  return { label: 'Pending', tone: 'warning' as const };
}

export function MembersPage() {
  const { user } = useAuth();
  const { members, reloadMembers } = useWorkspace();
  const invites = useResource(api.invites);
  const now = useNow(30_000);
  const [tab, setTab] = useState('members');
  const [inviting, setInviting] = useState(false);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [removingInvite, setRemovingInvite] = useState<Invite | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const openInvites = invites.data?.filter(invite => !invite.accepted_at && Date.parse(invite.expires_at) > now).length ?? 0;

  async function apply(member: Member, change: { role: Role } | { active: boolean }) {
    setBusyId(member.id);
    try {
      await api.editUser(member.id, change);
      const who = member.name || member.email;
      if ('role' in change) toast.success(`${who} is now ${change.role === 'admin' ? 'an admin' : 'a member'}`);
      else toast.success(change.active ? `${who} was reactivated` : `${who} was deactivated`, { description: change.active ? undefined : 'Their sessions and API keys stop working.' });
      reloadMembers();
    } catch (err) {
      toast.error('Could not update member', { description: errorMessage(err) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageContainer className="max-w-[1080px]">
      <PageHeader
        title="Members"
        description="Who can use the gateway and what they can manage."
        actions={<Button onClick={() => setInviting(true)}><UserPlus />Invite member</Button>}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Members and invitations">
          <TabsTrigger value="members">Members {members && <TabCount>{members.length}</TabCount>}</TabsTrigger>
          <TabsTrigger value="invites">Invitations {invites.data && <TabCount>{openInvites}</TabCount>}</TabsTrigger>
        </TabsList>

        <TabsContent value="members">
          <Card className="overflow-hidden">
            {!members ? (
              <div className="divide-y">{Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="flex items-center gap-3 px-4 py-3"><Skeleton className="size-7 rounded-full" /><Skeleton className="h-4 w-36" /><Skeleton className="ml-auto h-8 w-28" /><Skeleton className="h-[18px] w-8 rounded-full" /></div>
              ))}</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Member</TableHead>
                    <TableHead className="w-[116px] sm:w-[150px]">Role</TableHead>
                    <TableHead className="w-[56px] sm:w-[110px]">Active</TableHead>
                    <TableHead className="hidden w-[120px] sm:table-cell">Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map(member => {
                    const self = member.id === user?.id;
                    const busy = busyId === member.id;
                    return (
                      <TableRow key={member.id} className={cn(!member.active && 'opacity-60')}>
                        <TableCell className="w-full max-w-0 py-2">
                          <div className="flex min-w-0 items-center gap-3">
                            <Avatar name={member.name} email={member.email} />
                            <div className="min-w-0 flex-1 leading-tight">
                              <div className="flex min-w-0 items-center gap-2 font-medium">
                                <span className="truncate">{member.name || member.email.split('@')[0]}</span>
                                {self && <Badge tone="outline" className="h-[18px] px-1.5 text-[10.5px]">You</Badge>}
                              </div>
                              <div className="truncate text-xs text-muted-foreground">{member.email}</div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="py-2">
                          <SelfHint self={self} label="You can't change your own role">
                            <Select value={member.role} disabled={self || busy} onValueChange={value => setPending({ member, change: { role: value as Role } })}>
                              <SelectTrigger size="sm" className="w-[104px] sm:w-[120px]" aria-label={`Role for ${member.email}`}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="admin">Admin</SelectItem>
                                <SelectItem value="member">Member</SelectItem>
                              </SelectContent>
                            </Select>
                          </SelfHint>
                        </TableCell>
                        <TableCell className="py-2">
                          <SelfHint self={self} label="You can't deactivate yourself">
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={member.active}
                                disabled={self || busy}
                                aria-label={`${member.active ? 'Deactivate' : 'Activate'} ${member.email}`}
                                onCheckedChange={value => { if (value) void apply(member, { active: true }); else setPending({ member, change: { active: false } }); }}
                              />
                              {busy && <Loader className="size-3.5 animate-spin text-muted-foreground" />}
                            </div>
                          </SelfHint>
                        </TableCell>
                        <TableCell className="hidden text-subtle-foreground sm:table-cell"><Hint label={absoluteTime(member.created_at)}><span>{relativeTime(member.created_at, now)}</span></Hint></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="invites">
          <Card className="overflow-hidden">
            <InlineError className="m-4" message={invites.error} />
            {!invites.data && !invites.error && (
              <div className="divide-y">{Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="flex items-center gap-4 px-4 py-3"><Skeleton className="h-4 w-48" /><Skeleton className="h-5 w-16 rounded-full" /><Skeleton className="ml-auto h-4 w-20" /></div>
              ))}</div>
            )}
            {invites.data && invites.data.length === 0 && (
              <EmptyState className="py-8" icon={<Mail />} title="No invitations" description="Invite a teammate to give them access to the gateway." action={<Button variant="outline" size="sm" onClick={() => setInviting(true)}><UserPlus />Invite member</Button>} />
            )}
            {invites.data && invites.data.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden sm:table-cell">Expires</TableHead>
                    <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invites.data.map(invite => {
                    const status = inviteStatus(invite, now);
                    return (
                      <TableRow key={invite.id}>
                        <TableCell className="font-medium">{invite.email}</TableCell>
                        <TableCell><Badge tone={invite.role === 'admin' ? 'brand' : 'outline'} className="capitalize">{invite.role}</Badge></TableCell>
                        <TableCell><Badge tone={status.tone} dot>{status.label}</Badge></TableCell>
                        <TableCell className="hidden text-subtle-foreground sm:table-cell"><Hint label={absoluteTime(invite.expires_at)}><span>{invite.accepted_at ? '—' : relativeTime(invite.expires_at, now)}</span></Hint></TableCell>
                        <TableCell className="py-1.5">
                          {!invite.accepted_at && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon-sm" aria-label={`Actions for invitation to ${invite.email}`}><Ellipsis className="size-4" /></Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-44">
                                <DropdownMenuItem variant="destructive" onSelect={() => setRemovingInvite(invite)}><X />Revoke invitation…</DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmChange pending={pending} onClose={() => setPending(null)} onConfirm={change => { setPending(null); void apply(change.member, change.change); }} />
      <InviteDialog open={inviting} onOpenChange={setInviting} onCreated={() => { invites.reload(); setTab('invites'); }} />
      <RevokeInviteDialog invite={removingInvite} onClose={() => setRemovingInvite(null)} onRemoved={invites.reload} />
    </PageContainer>
  );
}

function SelfHint({ self, label, children }: { self: boolean; label: string; children: React.ReactNode }) {
  if (!self) return <>{children}</>;
  return <Hint label={label}><span tabIndex={0} className="inline-flex w-fit rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35">{children}</span></Hint>;
}

function ConfirmChange({ pending, onClose, onConfirm }: { pending: PendingChange | null; onClose: () => void; onConfirm: (change: PendingChange) => void }) {
  const who = pending ? pending.member.name || pending.member.email : '';
  let title = '';
  let description = '';
  let action = '';
  let destructive = false;
  if (pending && 'role' in pending.change) {
    const toAdmin = pending.change.role === 'admin';
    title = toAdmin ? `Make ${who} an admin?` : `Change ${who} to member?`;
    description = toAdmin
      ? 'Admins can add and remove servers, manage members and invitations, change tool permissions and read the full audit log.'
      : 'They lose access to server management, members, tool permissions and other people’s audit rows. Admin-only tools disappear from their clients.';
    action = toAdmin ? 'Make admin' : 'Change to member';
  } else if (pending) {
    title = `Deactivate ${who}?`;
    description = 'They are signed out, their API keys stop working, and they cannot sign in until you reactivate them.';
    action = 'Deactivate';
    destructive = true;
  }
  return (
    <AlertDialog open={!!pending} onOpenChange={open => { if (!open) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={() => pending && onConfirm(pending)}>{action}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function InviteDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [result, setResult] = useState<{ url: string; email: string; expires: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  function change(value: boolean) {
    if (!value) { setEmail(''); setRole('member'); setResult(null); setError(''); }
    onOpenChange(value);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError('');
    try {
      const created = await api.createInvite(email.trim(), role);
      setResult({ url: created.invite_url, email: created.email, expires: created.expires_at });
      toast.success(`Invitation created for ${created.email}`);
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="max-w-[480px]" onInteractOutside={event => { if (result) event.preventDefault(); }}>
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>Share the invitation link</DialogTitle>
              <DialogDescription>Send this one-time link to {result.email}. It expires {relativeTime(result.expires)} and is only shown now.</DialogDescription>
            </DialogHeader>
            <CodeBlock value={result.url} label="Copy link" toastLabel="Invitation link copied" wrap />
            <DialogFooter><Button onClick={() => change(false)}>Done</Button></DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>Invite a member</DialogTitle>
              <DialogDescription>You get a one-time link to share with them. No email is sent.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
              <div className="grid gap-2">
                <Label htmlFor="invite-email">Email</Label>
                <Input id="invite-email" type="email" autoFocus value={email} onChange={e => setEmail(e.target.value)} placeholder="teammate@company.com" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="invite-role">Role</Label>
                <Select value={role} onValueChange={value => setRole(value as Role)}>
                  <SelectTrigger id="invite-role" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <InlineError message={error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => change(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy || !valid}>{busy && <Loader className="animate-spin" />}Create invitation</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevokeInviteDialog({ invite, onClose, onRemoved }: { invite: Invite | null; onClose: () => void; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    if (!invite) return;
    setBusy(true);
    setError('');
    try {
      await api.removeInvite(invite.id);
      toast.success(`Revoked invitation for ${invite.email}`);
      onRemoved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AlertDialog open={!!invite} onOpenChange={open => { if (!open && !busy) { setError(''); onClose(); } }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke invitation for {invite?.email}?</AlertDialogTitle>
          <AlertDialogDescription>The link stops working immediately. You can send a new invitation later.</AlertDialogDescription>
        </AlertDialogHeader>
        <InlineError message={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy && <Loader className="animate-spin" />}Revoke</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
