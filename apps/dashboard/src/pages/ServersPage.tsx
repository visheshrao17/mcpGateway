import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ChevronRight, Ellipsis, Loader, Pencil, Plus, RefreshCw, Server as ServerIcon, ShieldCheck, Sparkles, Trash, TriangleAlert, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { errorMessage } from '@/hooks';
import { PageContainer } from '@/components/app-shell';
import { Chip, EmptyState, InlineError, PageHeader, ServerStatusBadge, StatusDot } from '@/components/common';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { TabCount, Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Hint } from '@/components/ui/tooltip';
import { absoluteTime, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace';
import type { AuthType, Server, ServerInput, Tool } from '@/types';

type Filter = 'all' | 'connected' | 'issues' | 'disabled';
const RECENT_CHANGE_MS = 24 * 60 * 60 * 1000;

function isDisabled(server: Server) { return !server.enabled || server.status === 'disabled'; }
function hasIssue(server: Server) { return server.enabled && (server.status === 'unreachable' || server.status === 'pending'); }
function recentlyChanged(server: Server, now: number) {
  if (!server.tools_changed_at) return false;
  const age = now - Date.parse(server.tools_changed_at);
  return age >= 0 && age < RECENT_CHANGE_MS;
}

export function ServersPage() {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const { servers, serversError, reloadServers, serversFetchedAt } = useWorkspace();
  const now = useNow(1000);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<Server | 'new' | null>(null);
  const [removing, setRemoving] = useState<Server | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);

  const list = servers ?? [];
  const counts = {
    all: list.length,
    connected: list.filter(server => server.enabled && server.status === 'connected').length,
    issues: list.filter(hasIssue).length,
    disabled: list.filter(isDisabled).length,
  };
  const unreachable = list.filter(server => server.enabled && server.status === 'unreachable').length;
  const exposed = list.filter(server => server.enabled).flatMap(server => server.tools);
  const adminOnly = exposed.filter(tool => tool.admin_only).length;
  const visible = list.filter(server => filter === 'all' ? true : filter === 'connected' ? server.enabled && server.status === 'connected' : filter === 'issues' ? hasIssue(server) : isDisabled(server));
  const lastChecked = list.reduce<number | undefined>((latest, server) => {
    const time = server.last_checked_at ? Date.parse(server.last_checked_at) : NaN;
    return Number.isNaN(time) ? latest : Math.max(latest ?? 0, time);
  }, undefined) ?? serversFetchedAt;

  function toggle(id: string) {
    setExpanded(old => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function refreshAll() {
    const targets = list.filter(server => server.enabled);
    if (!targets.length) return;
    setRefreshingAll(true);
    const results = await Promise.allSettled(targets.map(server => api.refreshServer(server.id)));
    setRefreshingAll(false);
    reloadServers();
    const failed = results.filter(result => result.status === 'rejected').length;
    if (failed) toast.error(`Refresh failed for ${failed} of ${targets.length} servers`);
    else toast.success(`Refreshed ${targets.length} ${targets.length === 1 ? 'server' : 'servers'}`);
  }

  return (
    <PageContainer>
      <PageHeader
        title="Servers"
        description={admin ? 'Upstream MCP servers and the tools they expose to your team.' : 'Upstream MCP servers and the tools available to you. Admins manage this list.'}
        actions={admin && (
          <>
            <Button variant="outline" onClick={() => void refreshAll()} disabled={refreshingAll || !list.some(server => server.enabled)}>
              <RefreshCw className={cn(refreshingAll && 'animate-spin')} />Refresh all
            </Button>
            <Button onClick={() => setEditing('new')}><Plus />Add server</Button>
          </>
        )}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Connected" indicator={<StatusDot tone="success" />} value={servers ? counts.connected : undefined} suffix={servers ? `of ${counts.all}` : undefined} />
        <StatCard label="Unreachable" indicator={<StatusDot tone={unreachable ? 'danger' : 'idle'} />} value={servers ? unreachable : undefined} />
        <StatCard label="Disabled" indicator={<StatusDot tone="idle" />} value={servers ? counts.disabled : undefined} />
        <StatCard label="Tools exposed" indicator={<Wrench className="size-3.5 text-muted-foreground" />} value={servers ? exposed.length : undefined} suffix={servers && adminOnly ? `${adminOnly} admin-only` : undefined} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Tabs value={filter} onValueChange={value => setFilter(value as Filter)}>
          <TabsList aria-label="Filter servers">
            <TabsTrigger value="all">All <TabCount>{counts.all}</TabCount></TabsTrigger>
            <TabsTrigger value="connected">Connected <TabCount>{counts.connected}</TabCount></TabsTrigger>
            <TabsTrigger value="issues">Issues <TabCount>{counts.issues}</TabCount></TabsTrigger>
            <TabsTrigger value="disabled">Disabled <TabCount>{counts.disabled}</TabCount></TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground" aria-live="off">
          {serversError ? (
            <><StatusDot tone="danger" />Connection lost · retrying</>
          ) : servers ? (
            <Hint label={lastChecked ? `Last health check ${absoluteTime(new Date(lastChecked).toISOString())}. The list updates every 5 seconds.` : 'The list updates every 5 seconds.'}>
              <span className="flex items-center gap-2" tabIndex={0}><StatusDot tone="success" pulse className="size-1.5 shadow-none" />Live · checked {relativeTime(lastChecked ?? null, now)}</span>
            </Hint>
          ) : null}
        </div>
      </div>

      {serversError && servers && <InlineError className="mb-3" message={`Could not refresh the server list: ${serversError}`} />}

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className={cn('hidden h-9 items-center gap-3 border-b bg-table-head px-4 text-xs font-medium text-muted-foreground md:grid', admin ? 'grid-cols-servers-admin' : 'grid-cols-servers')}>
          <span /><span>Server</span><span>Endpoint</span><span>Status</span><span>Tools</span><span>Last checked</span>{admin && <><span>Enabled</span><span className="sr-only">Actions</span></>}
        </div>
        {!servers && !serversError && Array.from({ length: 5 }, (_, index) => <SkeletonRow key={index} admin={admin} />)}
        {!servers && serversError && <EmptyState icon={<ServerIcon />} title="Servers unavailable" description={serversError} action={<Button variant="outline" onClick={reloadServers}><RefreshCw />Try again</Button>} />}
        {servers && servers.length === 0 && (
          <EmptyState
            icon={<ServerIcon />}
            title="No servers yet"
            description={admin ? 'Add an upstream MCP server to expose its tools through the gateway.' : 'Your administrator has not connected any MCP servers yet.'}
            action={admin && <Button onClick={() => setEditing('new')}><Plus />Add server</Button>}
          />
        )}
        {servers && servers.length > 0 && visible.length === 0 && (
          <EmptyState title={filter === 'issues' ? 'No issues' : 'Nothing here'} description={filter === 'issues' ? 'Every enabled server passed its last health check.' : 'No servers match this filter.'} />
        )}
        {visible.map(server => (
          <ServerRow
            key={server.id}
            server={server}
            admin={admin}
            now={now}
            open={expanded.has(server.id)}
            onToggle={() => toggle(server.id)}
            onEdit={() => setEditing(server)}
            onRemove={() => setRemoving(server)}
            onChanged={reloadServers}
          />
        ))}
      </div>

      {admin && (
        <ServerDialog
          server={editing}
          onOpenChange={open => { if (!open) setEditing(null); }}
          onSaved={() => { setEditing(null); reloadServers(); }}
        />
      )}
      {admin && <RemoveServerDialog server={removing} onClose={() => setRemoving(null)} onRemoved={reloadServers} />}
    </PageContainer>
  );
}

function StatCard({ label, indicator, value, suffix }: { label: string; indicator: ReactNode; value: number | undefined; suffix?: string }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3.5">
      <div className="flex items-center gap-2 text-[12.5px] text-subtle-foreground">{indicator}{label}</div>
      {value === undefined ? (
        <Skeleton className="mt-2 h-6 w-12" />
      ) : (
        <div className="tabular mt-1 text-[22px] font-semibold tracking-[-0.02em]">
          {value}
          {suffix && <span className="ml-1.5 text-[13px] font-normal tracking-normal text-muted-foreground">{suffix}</span>}
        </div>
      )}
    </div>
  );
}

function SkeletonRow({ admin }: { admin: boolean }) {
  return (
    <div className={cn('flex min-h-[58px] items-center gap-3 border-b px-4 last:border-0 md:grid', admin ? 'md:grid-cols-servers-admin' : 'md:grid-cols-servers')}>
      <Skeleton className="hidden size-3.5 md:block" />
      <div className="flex flex-1 items-center gap-2"><Skeleton className="h-4 w-36" /><Skeleton className="h-4 w-10" /></div>
      <Skeleton className="hidden h-3.5 w-4/5 md:block" />
      <Skeleton className="h-5 w-20 rounded-full" />
      <Skeleton className="hidden h-3.5 w-12 md:block" />
      <Skeleton className="hidden h-3.5 w-14 md:block" />
      {admin && <><Skeleton className="hidden h-[18px] w-8 rounded-full md:block" /><span className="hidden md:block" /></>}
    </div>
  );
}

function ServerRow({ server, admin, now, open, onToggle, onEdit, onRemove, onChanged }: {
  server: Server; admin: boolean; now: number; open: boolean;
  onToggle: () => void; onEdit: () => void; onRemove: () => void; onChanged: () => void;
}) {
  const [enabledOverride, setEnabledOverride] = useState<boolean | null>(null);
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!togglingEnabled && enabledOverride !== null && server.enabled === enabledOverride) setEnabledOverride(null);
  }, [server.enabled, enabledOverride, togglingEnabled]);
  const enabled = enabledOverride ?? server.enabled;
  const disabled = !enabled || server.status === 'disabled';
  const changed = recentlyChanged(server, now);
  const panelId = `server-tools-${server.id}`;

  async function setEnabled(value: boolean) {
    setEnabledOverride(value);
    setTogglingEnabled(true);
    try {
      await api.editServer(server.id, { enabled: value });
      toast.success(`${server.name} ${value ? 'enabled' : 'disabled'}`, { description: value ? 'Its tools are available to clients again.' : 'Its tools are hidden from every client.' });
      onChanged();
    } catch (err) {
      setEnabledOverride(null);
      toast.error(`Could not ${value ? 'enable' : 'disable'} ${server.name}`, { description: errorMessage(err) });
    } finally {
      setTogglingEnabled(false);
    }
  }
  async function refresh() {
    setRefreshing(true);
    try {
      await api.refreshServer(server.id);
      toast.success(`Checked ${server.name}`);
      onChanged();
    } catch (err) {
      toast.error(`Health check for ${server.name} failed`, { description: errorMessage(err) });
    } finally {
      setRefreshing(false);
    }
  }

  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <div className="border-b last:border-0">
      <div
        className={cn(
          'group grid cursor-pointer grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-accent/60 md:min-h-[58px] md:gap-y-0 md:py-2',
          admin ? 'md:grid-cols-servers-admin' : 'md:grid-cols-servers',
          open && 'bg-accent/60',
        )}
        onClick={onToggle}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${open ? 'Hide' : 'Show'} tools for ${server.name}`}
          onClick={event => { stop(event); onToggle(); }}
          className="grid size-5 place-items-center rounded text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          <ChevronRight className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')} />
        </button>
        <div className={cn('flex min-w-0 items-center gap-2', disabled && 'opacity-55')}>
          <span className="truncate font-medium" title={server.name}>{server.name}</span>
          <Chip>{server.slug}</Chip>
        </div>
        <Hint label={server.url}>
          <span className={cn('col-start-2 row-start-2 min-w-0 truncate font-mono text-xs text-muted-foreground md:col-start-auto md:row-start-auto', disabled && 'opacity-55')}>{server.url}</span>
        </Hint>
        <div className="col-start-3 row-start-1 justify-self-end md:col-start-auto md:row-start-auto md:justify-self-start"><ServerStatusBadge status={disabled ? 'disabled' : server.status} /></div>
        <div className="col-start-2 row-start-3 flex items-center gap-1.5 text-[13px] md:col-start-auto md:row-start-auto">
          <span className="tabular text-muted-foreground md:text-foreground">{server.tools.length ? `${server.tools.length} ${server.tools.length === 1 ? 'tool' : 'tools'}` : <><span className="md:hidden">No tools</span><span className="hidden md:inline">—</span></>}</span>
          {changed && (
            <Hint label={`Tool list changed ${relativeTime(server.tools_changed_at, now)}`}>
              <Sparkles className="size-3.5 text-brand-text" aria-label="Tool list changed recently" />
            </Hint>
          )}
          <span className="text-muted-foreground md:hidden">· checked {relativeTime(server.last_checked_at, now)}</span>
        </div>
        <Hint label={absoluteTime(server.last_checked_at)}>
          <span className="tabular hidden text-[12.5px] text-muted-foreground md:block">{relativeTime(server.last_checked_at, now)}</span>
        </Hint>
        {admin && (
          <>
            <div className="col-start-3 row-start-3 justify-self-end md:col-start-auto md:row-start-auto md:justify-self-start" onClick={stop}>
              <Switch checked={enabled} disabled={togglingEnabled} onCheckedChange={value => void setEnabled(value)} aria-label={`${enabled ? 'Disable' : 'Enable'} ${server.name}`} />
            </div>
            <div className="col-start-3 row-start-2 justify-self-end md:col-start-auto md:row-start-auto" onClick={stop}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${server.name}`}><Ellipsis className="size-4" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onSelect={onEdit}><Pencil />Edit</DropdownMenuItem>
                  <DropdownMenuItem disabled={refreshing || !enabled} onSelect={() => void refresh()}><RefreshCw />Refresh now</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={onRemove}><Trash />Remove…</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        )}
        {server.enabled && server.status === 'unreachable' && (
          <div className="col-span-full flex flex-wrap items-center gap-x-2 gap-y-1 pb-1 pt-2 text-[12.5px] text-danger-text md:col-start-2 md:pb-2 md:pt-0" onClick={stop}>
            <TriangleAlert className="size-3.5 shrink-0" />
            <span>Health check failed:</span>
            <Hint label={server.last_error ?? 'No reason reported'}>
              <code className="max-w-[min(420px,70vw)] truncate text-xs">{server.last_error ?? 'no reason reported'}</code>
            </Hint>
            {server.tools.length > 0 && <span className="text-danger-text/80">· tools kept from last good check</span>}
            {admin && (
              <Button variant="outline" size="xs" className="ml-1" disabled={refreshing} onClick={() => void refresh()}>
                <RefreshCw className={cn(refreshing && 'animate-spin')} />{refreshing ? 'Retrying…' : 'Retry'}
              </Button>
            )}
          </div>
        )}
      </div>
      {open && <ToolList id={panelId} server={server} admin={admin} now={now} changed={changed} onChanged={onChanged} />}
    </div>
  );
}

function ToolList({ id, server, admin, now, changed, onChanged }: { id: string; server: Server; admin: boolean; now: number; changed: boolean; onChanged: () => void }) {
  return (
    <div id={id} className="border-t bg-background px-4 pb-3 md:pl-[52px]">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1 pt-2.5 text-xs text-muted-foreground">
        <span>Tools · prefixed as <code className="text-[11.5px]">{server.slug}__</code></span>
        {changed && <span className="inline-flex items-center gap-1.5 text-brand-text"><Sparkles className="size-3" />Tool list changed {relativeTime(server.tools_changed_at, now)}</span>}
      </div>
      {server.tools.length === 0 ? (
        <p className="py-3 text-[13px] text-muted-foreground">{server.status === 'connected' ? 'This server exposes no tools.' : 'No tools yet. They appear after a successful health check.'}</p>
      ) : (
        <ul>
          {server.tools.map(tool => <ToolRow key={tool.name} server={server} tool={tool} admin={admin} onChanged={onChanged} />)}
        </ul>
      )}
    </div>
  );
}

function ToolRow({ server, tool, admin, onChanged }: { server: Server; tool: Tool; admin: boolean; onChanged: () => void }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!busy && override !== null && tool.admin_only === override) setOverride(null); }, [tool.admin_only, override, busy]);
  const adminOnly = override ?? tool.admin_only;
  async function setPolicy(value: boolean) {
    setOverride(value);
    setBusy(true);
    try {
      await api.toolPolicy(server.id, tool.name, value);
      toast.success(value ? `${tool.exposed_name} is now admin-only` : `${tool.exposed_name} is available to everyone`);
      onChanged();
    } catch (err) {
      setOverride(null);
      toast.error('Could not update tool access', { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-dashed py-2.5 last:border-0 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)_auto]">
      <div className="flex min-w-0 items-center gap-2">
        <code className="truncate text-[12.5px] text-foreground">{tool.exposed_name}</code>
        {adminOnly && <Badge tone="warning" className="h-5 px-1.5 text-[11px]"><ShieldCheck />Admin</Badge>}
      </div>
      <p className="col-span-2 row-start-2 line-clamp-2 text-[13px] text-subtle-foreground md:col-span-1 md:col-start-2 md:row-start-1" title={tool.description || undefined}>
        {tool.description || <span className="text-muted-foreground">No description provided.</span>}
      </p>
      {admin && (
        <label className="col-start-2 row-start-1 flex items-center gap-2 justify-self-end text-[12.5px] text-subtle-foreground md:col-start-3">
          <span className="hidden sm:inline">Admin only</span>
          <Switch checked={adminOnly} disabled={busy} onCheckedChange={value => void setPolicy(value)} aria-label={`Admin only: ${tool.exposed_name}`} />
        </label>
      )}
    </li>
  );
}

function RemoveServerDialog({ server, onClose, onRemoved }: { server: Server | null; onClose: () => void; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (server) setError(''); }, [server]);
  async function remove() {
    if (!server) return;
    setBusy(true);
    setError('');
    try {
      await api.removeServer(server.id);
      toast.success(`Removed ${server.name}`);
      onRemoved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AlertDialog open={!!server} onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {server?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its {server?.tools.length ?? 0} tools disappear from every connected client right away. Audit history is kept. You can add the server again later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <InlineError message={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy && <Loader className="animate-spin" />}Remove server
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const SLUG = /^[a-z0-9-]{1,20}$/;
function validUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/, '');
}

function ServerDialog({ server, onOpenChange, onSaved }: { server: Server | 'new' | null; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const [key, setKey] = useState(0);
  useEffect(() => { if (server) setKey(value => value + 1); }, [server]);
  const current = server && server !== 'new' ? server : undefined;
  return (
    <Dialog open={!!server} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{current ? `Edit ${current.name}` : 'Add server'}</DialogTitle>
          <DialogDescription>{current ? 'Changes apply to every client immediately.' : 'Connect an upstream MCP server over Streamable HTTP. Its tools are prefixed with the slug.'}</DialogDescription>
        </DialogHeader>
        {server && <ServerForm key={key} server={current} onSaved={onSaved} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function ServerForm({ server, onSaved, onCancel }: { server?: Server; onSaved: () => void; onCancel: () => void }) {
  const [slug, setSlug] = useState(server?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(!!server);
  const [name, setName] = useState(server?.name ?? '');
  const [url, setUrl] = useState(server?.url ?? '');
  const [authType, setAuthType] = useState<AuthType>(server?.auth_type ?? 'none');
  const [headerName, setHeaderName] = useState(server?.auth_header_name ?? '');
  const [credential, setCredential] = useState('');
  const [credentialMode, setCredentialMode] = useState<'keep' | 'replace' | 'clear'>(server?.has_credential ? 'keep' : 'replace');
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const errors = useMemo(() => {
    const result: Record<string, string> = {};
    if (!server && !SLUG.test(slug)) result.slug = 'Use 1–20 lowercase letters, numbers or hyphens.';
    if (!name.trim()) result.name = 'Give the server a name.';
    if (!validUrl(url.trim())) result.url = 'Enter a full http:// or https:// URL.';
    if (authType === 'header' && !/^[A-Za-z0-9-]{1,64}$/.test(headerName.trim())) result.headerName = 'Enter a header name such as X-Api-Key.';
    if (authType !== 'none' && credentialMode === 'replace' && !credential) result.credential = server?.has_credential ? 'Enter the new credential or cancel the replacement.' : 'Enter the credential the server expects.';
    return result;
  }, [server, slug, name, url, authType, headerName, credential, credentialMode]);
  const show = (field: string) => (submitted || touched[field]) && errors[field];
  const blur = (field: string) => () => setTouched(old => ({ ...old, [field]: true }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setError('');
    try {
      const body: ServerInput = { slug, name: name.trim(), url: url.trim(), auth_type: authType, auth_header_name: authType === 'header' ? headerName.trim() : null };
      if (credentialMode === 'clear' || (authType === 'none' && server?.has_credential && credentialMode !== 'keep')) body.credential = null;
      if (credentialMode === 'replace' && credential && authType !== 'none') body.credential = credential;
      if (server) {
        const { slug: _slug, ...changes } = body;
        void _slug;
        await api.editServer(server.id, changes);
        toast.success(`Saved ${body.name}`);
      } else {
        await api.addServer(body);
        toast.success(`Added ${body.name}`, { description: 'The gateway is running its first health check.' });
      }
      setCredential('');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
        <Field id="server-name" label="Name" error={show('name')}>
          <Input id="server-name" value={name} autoFocus={!server} onBlur={blur('name')} aria-invalid={!!show('name') || undefined}
            onChange={e => { setName(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)); }} placeholder="WooCommerce store" />
        </Field>
        <Field id="server-slug" label="Slug" error={show('slug')} hint={server ? 'Cannot change' : undefined}>
          <Input id="server-slug" value={slug} disabled={!!server} maxLength={20} onBlur={blur('slug')} aria-invalid={!!show('slug') || undefined} className="font-mono text-[13px]"
            onChange={e => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }} placeholder="woo" />
        </Field>
      </div>
      <Field id="server-url" label="MCP endpoint URL" error={show('url')}>
        <Input id="server-url" type="url" inputMode="url" value={url} onBlur={blur('url')} aria-invalid={!!show('url') || undefined} className="font-mono text-[13px]"
          onChange={e => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
      </Field>
      <div className={cn('grid gap-4', authType === 'header' && 'sm:grid-cols-2')}>
        <Field id="server-auth" label="Authentication">
          <Select value={authType} onValueChange={value => setAuthType(value as AuthType)}>
            <SelectTrigger id="server-auth" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="bearer">Bearer token</SelectItem>
              <SelectItem value="header">Custom header</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {authType === 'header' && (
          <Field id="server-header" label="Header name" error={show('headerName')}>
            <Input id="server-header" value={headerName} onBlur={blur('headerName')} aria-invalid={!!show('headerName') || undefined} className="font-mono text-[13px]"
              onChange={e => setHeaderName(e.target.value)} placeholder="X-Api-Key" />
          </Field>
        )}
      </div>
      {authType !== 'none' && (
        <div className="grid gap-2">
          <Label htmlFor="server-credential">{authType === 'bearer' ? 'Bearer token' : 'Header value'}</Label>
          {credentialMode === 'keep' && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/60 px-3 py-1.5">
              <ShieldCheck className="size-3.5 text-success-text" />
              <span className="flex-1 text-[13px]">Credential set</span>
              <Button type="button" variant="ghost" size="xs" onClick={() => setCredentialMode('replace')}>Replace</Button>
              <Button type="button" variant="destructive-ghost" size="xs" onClick={() => setCredentialMode('clear')}>Clear</Button>
            </div>
          )}
          {credentialMode === 'clear' && (
            <div className="flex items-center gap-2 rounded-md border border-danger/25 bg-danger-soft px-3 py-1.5 text-danger-text">
              <span className="flex-1 text-[13px]">The saved credential will be removed when you save.</span>
              <Button type="button" variant="ghost" size="xs" onClick={() => setCredentialMode('keep')}>Undo</Button>
            </div>
          )}
          {credentialMode === 'replace' && (
            <div className="flex gap-2">
              <Input id="server-credential" type="password" autoComplete="new-password" value={credential} onBlur={blur('credential')} aria-invalid={!!show('credential') || undefined}
                onChange={e => setCredential(e.target.value)} placeholder={server?.has_credential ? 'New credential' : 'Paste the credential'} />
              {server?.has_credential && <Button type="button" variant="outline" className="h-9" onClick={() => { setCredential(''); setCredentialMode('keep'); }}>Cancel</Button>}
            </div>
          )}
          {show('credential') ? <p className="text-xs text-danger-text">{errors.credential}</p> : <p className="text-xs text-muted-foreground">Write-only. The gateway never shows a saved credential again.</p>}
        </div>
      )}
      <InlineError message={error} />
      <DialogFooter className="pt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy && <Loader className="animate-spin" />}{server ? 'Save changes' : 'Add server'}</Button>
      </DialogFooter>
    </form>
  );
}

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string | false; hint?: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
      {error && <p className="text-xs text-danger-text" id={`${id}-error`}>{error}</p>}
    </div>
  );
}
