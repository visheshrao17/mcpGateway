import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Info, Loader, RefreshCw } from 'lucide-react';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { errorMessage } from '@/hooks';
import { PageContainer } from '@/components/app-shell';
import { EmptyState, InlineError, OutcomeBadge, PageHeader } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Hint } from '@/components/ui/tooltip';
import { absoluteTime, formatDuration, outcomeMeta, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace';
import { outcomes } from '@/types';
import type { AuditRow } from '@/types';

const ALL = 'all';

export function AuditPage() {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const { servers, members } = useWorkspace();
  const now = useNow(5_000);
  const [userId, setUserId] = useState(ALL);
  const [server, setServer] = useState(ALL);
  const [outcome, setOutcome] = useState(ALL);
  const [auto, setAuto] = useState(false);
  const [rows, setRows] = useState<AuditRow[] | undefined>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);

  const params = useCallback(() => {
    const query = new URLSearchParams({ limit: '50' });
    if (admin && userId !== ALL) query.set('user_id', userId);
    if (server !== ALL) query.set('server', server);
    if (outcome !== ALL) query.set('outcome', outcome);
    return query;
  }, [admin, userId, server, outcome]);

  useEffect(() => {
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      setLoading(true);
      try {
        const result = await api.audit(params());
        if (generation.current === current) { setRows(result.rows); setCursor(result.next_before_id); setError(''); }
      } catch (err) {
        if (generation.current === current) setError(errorMessage(err));
      } finally {
        if (generation.current === current) {
          setLoading(false);
          if (auto) timer = setTimeout(load, 5000);
        }
      }
    }
    void load();
    return () => { generation.current++; clearTimeout(timer); };
  }, [params, auto, revision]);

  // Filters reset the list so stale rows never show under new filters.
  useEffect(() => { setRows(undefined); setCursor(null); }, [params]);

  async function more() {
    if (!cursor || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    setError('');
    try {
      const query = params();
      query.set('before_id', cursor);
      const result = await api.audit(query);
      if (generation.current === current) {
        setRows(old => [...new Map([...(old ?? []), ...result.rows].map(row => [row.id, row])).values()]);
        setCursor(result.next_before_id);
      }
    } catch (err) {
      if (generation.current === current) setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  const filtered = userId !== ALL || server !== ALL || outcome !== ALL;
  const list = rows ?? [];
  return (
    <PageContainer>
      <PageHeader title="Audit log" description={admin ? 'Every tool call through the gateway, from MCP clients and chat.' : 'Your tool calls from MCP clients and chat.'} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {admin && (
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger size="sm" className="w-full sm:w-[200px]" aria-label="Filter by user"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All users</SelectItem>
              <SelectSeparator />
              {members?.map(member => <SelectItem key={member.id} value={member.id}>{member.email}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={server} onValueChange={setServer}>
          <SelectTrigger size="sm" className="w-[calc(50%-4px)] sm:w-[170px]" aria-label="Filter by server"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All servers</SelectItem>
            <SelectSeparator />
            {servers?.map(item => <SelectItem key={item.id} value={item.slug}>{item.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={outcome} onValueChange={setOutcome}>
          <SelectTrigger size="sm" className="w-[calc(50%-4px)] sm:w-[170px]" aria-label="Filter by outcome"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All outcomes</SelectItem>
            <SelectSeparator />
            {outcomes.map(item => <SelectItem key={item} value={item}>{outcomeMeta[item].label}</SelectItem>)}
          </SelectContent>
        </Select>
        {filtered && <Button variant="ghost" size="sm" onClick={() => { setUserId(ALL); setServer(ALL); setOutcome(ALL); }}>Clear</Button>}
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-2 text-[12.5px] text-subtle-foreground">
            <Switch checked={auto} onCheckedChange={setAuto} aria-label="Auto-refresh every 5 seconds" />
            Auto-refresh
          </label>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => setRevision(value => value + 1)}>
            <RefreshCw className={cn(loading && rows && 'animate-spin')} />Refresh
          </Button>
        </div>
      </div>

      <InlineError className="mb-3" message={error} />

      <Card className="overflow-hidden">
        {/* Desktop: dense table */}
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[96px]">Time</TableHead>
                {admin && <TableHead>User</TableHead>}
                <TableHead className="w-[72px]">Source</TableHead>
                <TableHead>Server</TableHead>
                <TableHead>Tool</TableHead>
                <TableHead className="w-[84px] text-right">Duration</TableHead>
                <TableHead className="w-[130px]">Outcome</TableHead>
                <TableHead className="w-[28%]">Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!rows && Array.from({ length: 8 }, (_, index) => (
                <TableRow key={index} className="h-9 hover:bg-transparent">
                  <TableCell className="py-0"><Skeleton className="h-3.5 w-14" /></TableCell>
                  {admin && <TableCell className="py-0"><Skeleton className="h-3.5 w-36" /></TableCell>}
                  <TableCell className="py-0"><Skeleton className="h-4 w-10 rounded-full" /></TableCell>
                  <TableCell className="py-0"><Skeleton className="h-3.5 w-14" /></TableCell>
                  <TableCell className="py-0"><Skeleton className="h-3.5 w-32" /></TableCell>
                  <TableCell className="py-0"><Skeleton className="ml-auto h-3.5 w-10" /></TableCell>
                  <TableCell className="py-0"><Skeleton className="h-5 w-14 rounded-full" /></TableCell>
                  <TableCell className="py-0"><Skeleton className="h-3.5 w-24" /></TableCell>
                </TableRow>
              ))}
              {list.map(row => (
                <TableRow key={row.id} className="h-9">
                  <TableCell className="py-0 text-[12.5px] text-muted-foreground">
                    <Hint label={absoluteTime(row.started_at)}><span className="tabular">{relativeTime(row.started_at, now)}</span></Hint>
                  </TableCell>
                  {admin && <TableCell className="max-w-[220px] truncate py-0 text-subtle-foreground">{row.user_email}</TableCell>}
                  <TableCell className="py-0"><SourceBadge source={row.source} /></TableCell>
                  <TableCell className="py-0"><code className="text-xs text-subtle-foreground">{row.server_slug || '—'}</code></TableCell>
                  <TableCell className="max-w-[260px] truncate py-0"><code className="text-[12.5px]">{row.tool_name}</code></TableCell>
                  <TableCell className="tabular py-0 text-right text-[12.5px] text-subtle-foreground">{formatDuration(row.duration_ms)}</TableCell>
                  <TableCell className="py-0"><OutcomeBadge outcome={row.outcome} className="h-5 text-[11.5px]" /></TableCell>
                  <TableCell className="max-w-0 py-0">
                    {row.error ? (
                      <Hint label={<span className="block max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{row.error}</span>}>
                        <span className="block truncate font-mono text-xs text-danger-text" tabIndex={0}>{row.error}</span>
                      </Hint>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Mobile: cards */}
        <ul className="divide-y md:hidden">
          {!rows && Array.from({ length: 5 }, (_, index) => (
            <li key={index} className="space-y-2 px-4 py-3"><Skeleton className="h-3.5 w-40" /><Skeleton className="h-3 w-56" /></li>
          ))}
          {list.map(row => (
            <li key={row.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <code className="min-w-0 truncate text-[12.5px]">{row.tool_name}</code>
                <OutcomeBadge outcome={row.outcome} className="h-5 text-[11.5px]" />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                <span className="tabular">{relativeTime(row.started_at, now)}</span>
                <span>·</span><SourceBadge source={row.source} />
                {row.server_slug && <><span>·</span><code>{row.server_slug}</code></>}
                <span>·</span><span className="tabular">{formatDuration(row.duration_ms)}</span>
              </div>
              {admin && <div className="mt-0.5 truncate text-xs text-muted-foreground">{row.user_email}</div>}
              {row.error && <p className="mt-1.5 line-clamp-2 break-all font-mono text-xs text-danger-text">{row.error}</p>}
            </li>
          ))}
        </ul>

        {rows && rows.length === 0 && (
          <EmptyState
            icon={<Activity />}
            title={filtered ? 'No calls match these filters' : 'No tool calls yet'}
            description={filtered ? 'Try a different user, server or outcome.' : 'Calls from MCP clients and chat show up here as they happen.'}
            action={filtered && <Button variant="outline" size="sm" onClick={() => { setUserId(ALL); setServer(ALL); setOutcome(ALL); }}>Clear filters</Button>}
          />
        )}
      </Card>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="tabular text-xs text-muted-foreground">
          {rows ? `${rows.length} ${rows.length === 1 ? 'call' : 'calls'} shown` : ''}
          {auto && ' · refreshing every 5 seconds'}
        </span>
        {cursor && !auto && rows && rows.length > 0 && (
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void more()}>
            {loadingMore && <Loader className="animate-spin" />}Load more
          </Button>
        )}
        {cursor && auto && <span className="text-xs text-muted-foreground">Pause auto-refresh to load older calls.</span>}
      </div>

      {list.some(row => row.outcome === 'unknown') && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning-text">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span><strong className="font-medium">Unknown outcome</strong> means a write timed out after it was sent. It may have been applied upstream.</span>
        </div>
      )}
    </PageContainer>
  );
}

function SourceBadge({ source }: { source: AuditRow['source'] }) {
  return <Badge tone={source === 'chat' ? 'brand' : 'outline'} className="h-[18px] px-1.5 text-[10.5px] font-semibold tracking-wide">{source === 'chat' ? 'Chat' : 'MCP'}</Badge>;
}
