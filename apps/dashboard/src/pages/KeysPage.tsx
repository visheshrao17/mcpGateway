import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { Ellipsis, KeyRound, Loader, Plus, TriangleAlert, Ban } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { errorMessage, useResource } from '@/hooks';
import { PageContainer } from '@/components/app-shell';
import { CodeBlock, EmptyState, InlineError, PageHeader } from '@/components/common';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Hint } from '@/components/ui/tooltip';
import { absoluteTime, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace';
import type { ApiKey } from '@/types';

export function KeysPage() {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const { meta } = useWorkspace();
  const [all, setAll] = useState(false);
  const keys = useResource(useCallback(() => api.keys(all), [all]));
  const now = useNow(15_000);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const showOwner = admin && all;
  const list = keys.data ?? [];
  const activeCount = list.filter(key => !key.revoked_at).length;

  return (
    <PageContainer className="max-w-[1080px]">
      <PageHeader
        title="API keys"
        description="Personal keys that let MCP clients reach the gateway as you."
        actions={<Button onClick={() => setCreating(true)}><Plus />Create key</Button>}
      />

      <Card className="mb-5 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-semibold">{showOwner ? 'All keys' : 'Your keys'}</h2>
            {keys.data && <span className="tabular text-xs text-muted-foreground">{activeCount} active{list.length > activeCount ? ` · ${list.length - activeCount} revoked` : ''}</span>}
          </div>
          {admin && (
            <label className="flex items-center gap-2 text-[12.5px] text-subtle-foreground">
              <Switch checked={all} onCheckedChange={setAll} aria-label="Show keys from all users" />
              All users
            </label>
          )}
        </div>
        <InlineError className="m-4" message={keys.error} />
        {!keys.data && !keys.error && (
          <div className="divide-y">{Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex items-center gap-6 px-4 py-3"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-28" /><Skeleton className="ml-auto h-4 w-16" /><Skeleton className="h-5 w-16 rounded-full" /></div>
          ))}</div>
        )}
        {keys.data && list.length === 0 && (
          <EmptyState
            className="py-8"
            icon={<KeyRound />}
            title={showOwner ? 'No keys in this workspace' : 'No keys yet'}
            description="Create a key, then paste it into Claude Code, Cursor or any MCP client."
            action={<Button variant="outline" size="sm" onClick={() => setCreating(true)}><Plus />Create key</Button>}
          />
        )}
        {list.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead className="hidden sm:table-cell">Key</TableHead>
                {showOwner && <TableHead>Owner</TableHead>}
                <TableHead className="hidden sm:table-cell">Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map(key => (
                <TableRow key={key.id} className={cn(key.revoked_at && 'text-muted-foreground')}>
                  <TableCell className="max-w-[220px] truncate font-medium">
                    {key.name}
                    <code className="block text-[11px] font-normal text-muted-foreground sm:hidden">{key.prefix}…</code>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell"><code className="text-xs text-subtle-foreground">{key.prefix}…</code></TableCell>
                  {showOwner && <TableCell className="text-subtle-foreground">{key.user_email}</TableCell>}
                  <TableCell className="hidden text-subtle-foreground sm:table-cell"><Hint label={absoluteTime(key.created_at)}><span>{relativeTime(key.created_at, now)}</span></Hint></TableCell>
                  <TableCell className="text-subtle-foreground">{key.last_used_at ? <Hint label={absoluteTime(key.last_used_at)}><span>{relativeTime(key.last_used_at, now)}</span></Hint> : <span className="text-muted-foreground">Never</span>}</TableCell>
                  <TableCell>
                    {key.revoked_at
                      ? <Hint label={`Revoked ${absoluteTime(key.revoked_at)}`}><span><Badge tone="idle" dot>Revoked</Badge></span></Hint>
                      : <Badge tone="success" dot>Active</Badge>}
                  </TableCell>
                  <TableCell className="py-1.5">
                    {!key.revoked_at && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for key ${key.name}`}><Ellipsis className="size-4" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem variant="destructive" onSelect={() => setRevoking(key)}><Ban />Revoke…</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <ConnectCard url={meta?.mcp_url} secret={created?.key} onForget={() => setCreated(null)} />

      <CreateKeyDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={result => { setCreated(result); keys.reload(); }}
      />
      <RevokeDialog keyItem={revoking} onClose={() => setRevoking(null)} onRevoked={keys.reload} />
    </PageContainer>
  );
}

function CreateKeyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (result: { name: string; key: string }) => void }) {
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function change(value: boolean) {
    if (!value) { setName(''); setSecret(''); setError(''); }
    onOpenChange(value);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.createKey(name.trim());
      setSecret(result.key);
      onCreated({ name: result.name, key: result.key });
      toast.success(`Created key “${result.name}”`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="max-w-[480px]" onInteractOutside={event => { if (secret) event.preventDefault(); }}>
        {secret ? (
          <>
            <DialogHeader>
              <DialogTitle>Copy your new key</DialogTitle>
              <DialogDescription>Use it as a Bearer token in any MCP client.</DialogDescription>
            </DialogHeader>
            <CodeBlock value={secret} label="Copy key" toastLabel="API key copied" wrap />
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-warning-text">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>This key won't be shown again. Store it somewhere safe; if you lose it, revoke it and create a new one.</span>
            </div>
            <DialogFooter><Button onClick={() => change(false)}>Done</Button></DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>Name it after the client or machine that will use it.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" autoFocus value={name} maxLength={100} onChange={e => setName(e.target.value)} placeholder="Claude Code on my laptop" />
            </div>
            <InlineError message={error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => change(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy || !name.trim()}>{busy && <Loader className="animate-spin" />}Create key</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({ keyItem, onClose, onRevoked }: { keyItem: ApiKey | null; onClose: () => void; onRevoked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function revoke() {
    if (!keyItem) return;
    setBusy(true);
    setError('');
    try {
      await api.revokeKey(keyItem.id);
      toast.success(`Revoked “${keyItem.name}”`);
      onRevoked();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AlertDialog open={!!keyItem} onOpenChange={open => { if (!open && !busy) { setError(''); onClose(); } }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke “{keyItem?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>Clients using <code className="text-xs">{keyItem?.prefix}…</code> lose access immediately. This can't be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <InlineError message={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={() => void revoke()}>{busy && <Loader className="animate-spin" />}Revoke key</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function shellQuote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }

function ConnectCard({ url, secret, onForget }: { url?: string; secret?: string; onForget: () => void }) {
  const key = secret || '<YOUR_API_KEY>';
  const mcpUrl = url ?? '';
  const claude = `claude mcp add --transport http urumi ${shellQuote(mcpUrl)} \\\n  --header ${shellQuote(`Authorization: Bearer ${key}`)}`;
  const cursor = JSON.stringify({ mcpServers: { urumi: { url: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
  return (
    <Card>
      <CardHeader className="pb-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Connect a client</CardTitle>
            <CardDescription className="mt-1">
              {secret ? 'These snippets include the key you just created. Treat them as secrets.' : <>Replace <code className="text-xs text-foreground">&lt;YOUR_API_KEY&gt;</code> with a key from above.</>}
            </CardDescription>
          </div>
          {secret && <Button variant="ghost" size="sm" onClick={onForget}>Forget key</Button>}
        </div>
      </CardHeader>
      <div className="px-5 pb-5 pt-3">
        {!url ? (
          <div className="space-y-2"><Skeleton className="h-8 w-72" /><Skeleton className="h-20" /></div>
        ) : (
          <Tabs defaultValue="claude">
            <TabsList aria-label="Client">
              <TabsTrigger value="claude">Claude Code</TabsTrigger>
              <TabsTrigger value="cursor">Cursor</TabsTrigger>
              <TabsTrigger value="inspector">MCP Inspector</TabsTrigger>
            </TabsList>
            <TabsContent value="claude" className="space-y-2">
              <p className="text-[13px] text-muted-foreground">Run in a terminal:</p>
              <CodeBlock value={claude} label="Copy command" toastLabel="Command copied" />
            </TabsContent>
            <TabsContent value="cursor" className="space-y-2">
              <p className="text-[13px] text-muted-foreground">Add to <code className="text-xs text-foreground">~/.cursor/mcp.json</code>:</p>
              <CodeBlock value={cursor} label="Copy configuration" toastLabel="Configuration copied" />
            </TabsContent>
            <TabsContent value="inspector" className="space-y-3">
              <ol className="grid gap-2.5 text-[13px]">
                <Step n={1}>Open MCP Inspector and pick the <strong className="font-medium">Streamable HTTP</strong> transport.</Step>
                <Step n={2}>Set the URL:<CodeBlock className="mt-1.5" value={mcpUrl} label="Copy URL" toastLabel="URL copied" /></Step>
                <Step n={3}>Add the header <code className="text-xs">Authorization</code> with this value:<CodeBlock className="mt-1.5" value={`Bearer ${key}`} label="Copy header value" toastLabel="Header value copied" /></Step>
                <Step n={4}>Connect, then list or call tools.</Step>
              </ol>
            </TabsContent>
          </Tabs>
        )}
      </div>
    </Card>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[20px_minmax(0,1fr)] gap-2.5">
      <span className="tabular mt-px grid size-5 place-items-center rounded-full border bg-muted text-[11px] font-medium text-subtle-foreground">{n}</span>
      <div className="min-w-0">{children}</div>
    </li>
  );
}
